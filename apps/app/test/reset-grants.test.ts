// Claude reset grants: the pure status parsing, grant choice and claim journal (src/quota/reset-grants.ts), then
// `GET /v9/management/credentials/reset-grants` and `POST .../claim` through the router with the real ControlPlane and
// mocked Anthropic endpoints, the quota check's tolerated grant read, the contract and the Access/CSRF gates.
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { assert, describe, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { afterAll, beforeEach, expect } from "vitest";
import { authIndexOf } from "./support/auth-index.ts";
import { ManagementApi } from "@commissary/contract/api";
import { CredentialEntry, type ResetGrantStatus } from "@commissary/contract/credentials";
import { ManagementError } from "@commissary/contract/errors";
import type { Json } from "@commissary/json";
import { runQuotaSweep } from "../src/quota/check.ts";
import { CLAUDE_PROFILE_URL, CLAUDE_USAGE_URL } from "../src/quota/claude.ts";
import { claimResetGrant } from "../src/quota/reset-grant-flow.ts";
import {
  beginClaim,
  CLAIM_LEASE_MS,
  claimAnswer,
  type ClaimJournal,
  claimLanded,
  landedAnswer,
  parseOrganization,
  parseResetGrantStatus,
  pendingClaimJson,
  RESET_GRANT_STATUS_URL,
  resetGrantClaimUrl,
  RETRY_WINDOW_MS,
  selectResetGrant,
  settleClaim,
} from "../src/quota/reset-grants.ts";
import {
  claudeFile,
  controlPlane,
  type Harness,
  jsonInit,
  makeHarness,
  resetControlPlane,
  token,
} from "./support/management.ts";
import { type MockReply, mockHttp, routes } from "./support/refresh.ts";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { envContext } from "../src/worker-env.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");

const grant = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: "Launch week",
  resets_total: 3,
  resets_left: 2,
  starts_at: "2026-01-01T00:00:00Z",
  ends_at: "2999-01-01T00:00:00Z",
  clears: ["five_hour", "seven_day"],
  paused: false,
  usable_now: true,
  use_requires_limit: false,
  ...extra,
});

const block = (extra: Record<string, unknown> = {}) => ({
  eligible: true,
  at_limit: true,
  weekly_resets_at: "2026-10-14T00:00:00Z",
  grants: [grant("g1")],
  ...extra,
});

const usage = (extra: Record<string, unknown> = {}) => ({
  five_hour: { utilization: 100 },
  cedar_ember: block(extra),
});

const parse = (payload: Json | undefined) => parseResetGrantStatus(payload, NOW);

describe("parseResetGrantStatus", () => {
  it("reads the block and picks the claimable grant", () => {
    const status = parse(
      usage({
        ineligible_reason: "something_new",
        next_grant_id: "g2",
        cooldown_until: "2026-10-11T11:00:00Z",
        grants: [
          grant("g1", {
            label: "  Bonus\u0000\nreset  ",
            clears: ["five_hour", "Bad Id!", "five_hour"],
          }),
          grant("g2", { resets_left: 1 }),
        ],
      }),
    );

    expect(status).toEqual({
      checked_at: new Date(NOW).toISOString(),
      eligible: true,
      ineligible_reason: "unknown",
      at_limit: true,
      cooldown_until: "2026-10-11T11:00:00.000Z",
      weekly_resets_at: "2026-10-14T00:00:00.000Z",
      next_grant_id: "g2",
      grants: [
        expect.objectContaining({ id: "g1", label: "Bonus reset", clears: ["five_hour"] }),
        expect.objectContaining({ id: "g2", resets_left: 1, resets_total: 3 }),
      ],
      claimable: "g2",
    });
  });

  it("fails closed on missing usability flags", () => {
    const status = parse(
      usage({ at_limit: false, grants: [{ id: "g1", resets_total: 1, resets_left: 1 }] }),
    );

    expect(status?.grants[0]).toMatchObject({
      usable_now: false,
      use_requires_limit: true,
      paused: false,
      label: "",
      clears: [],
    });
    expect(status?.blocked_by).toBe("unusable");
  });

  it("rejects the whole block on one malformed grant", () => {
    for (const bad of [
      [grant("g1"), grant("g1")],
      [grant("G 1")],
      [grant("g1", { resets_left: 4 })],
      [grant("g1", { ends_at: "not a date" })],
      [grant("g1", { resets_left: -1 })],
    ]) {
      expect(parse(usage({ grants: bad })), JSON.stringify(bad)).toBeUndefined();
    }

    expect(parse({ cedar_ember: null })).toBeUndefined();
    expect(parse({ five_hour: {} })).toBeUndefined();
    expect(parse(undefined)).toBeUndefined();
  });

  it("drops a next_grant_id that names no grant", () => {
    expect(parse(usage({ next_grant_id: "ghost" }))).not.toHaveProperty("next_grant_id");
  });
});

describe("selectResetGrant", () => {
  const status = (extra: Partial<ResetGrantStatus> = {}) => {
    const parsed = parse(usage());

    if (parsed === undefined) throw new Error("fixture does not parse");

    return { ...parsed, ...extra };
  };

  const one = (extra: Record<string, unknown>) =>
    status({ grants: [parse(usage({ grants: [grant("g1", extra)] }))!.grants[0]!] });

  it("explains every blocker in the panel's order", () => {
    expect(selectResetGrant(status({ eligible: false }), NOW)).toEqual({
      blocked_by: "ineligible",
    });
    expect(selectResetGrant(status({ cooldown_until: "2026-10-11T13:00:00.000Z" }), NOW)).toEqual({
      blocked_by: "cooldown",
    });
    expect(selectResetGrant(one({ resets_left: 0 }), NOW)).toEqual({ blocked_by: "none_left" });
    expect(selectResetGrant(one({ ends_at: "2026-10-01T00:00:00Z" }), NOW)).toEqual({
      blocked_by: "none_left",
    });
    expect(selectResetGrant(one({ starts_at: "2026-12-01T00:00:00Z" }), NOW)).toEqual({
      blocked_by: "none_left",
    });
    expect(selectResetGrant(one({ paused: true }), NOW)).toEqual({ blocked_by: "unusable" });
    expect(
      selectResetGrant({ ...one({ use_requires_limit: true }), at_limit: false }, NOW),
    ).toEqual({ blocked_by: "not_limited" });
  });

  it("prefers next_grant_id, else the lowest usable id", () => {
    const two = parse(
      usage({ grants: [grant("zz"), grant("aa"), grant("mm", { paused: true })] }),
    )!;

    expect(selectResetGrant(two, NOW)).toEqual({ claimable: "aa" });
    expect(selectResetGrant({ ...two, next_grant_id: "zz" }, NOW)).toEqual({ claimable: "zz" });
    expect(selectResetGrant({ ...two, next_grant_id: "mm" }, NOW)).toEqual({ claimable: "aa" });
  });
});

describe("claim answers and organization", () => {
  it("maps statuses and results like the panel", () => {
    expect(claimAnswer(200, { result: "reset" })).toBe("reset");
    expect(claimAnswer(200, { result: "already_used" })).toBe("already_used");
    expect(claimAnswer(200, { result: "surprise" })).toBe("unknown");
    expect(claimAnswer(200, {})).toBe("unknown");
    expect(claimAnswer(429, { result: "reset" })).toBe("rate_limited");
    expect(claimAnswer(401, undefined)).toBe("auth_error");
    expect(claimAnswer(403, undefined)).toBe("auth_error");
    expect(claimAnswer(500, { result: "reset" })).toBe("unknown");
  });

  it("reads only a UUID organization", () => {
    expect(
      parseOrganization({ organization: { uuid: "ABCDEF01-2345-6789-ABCD-EF0123456789" } }),
    ).toBe("abcdef01-2345-6789-abcd-ef0123456789");
    expect(parseOrganization({ organization: { uuid: "../../admin" } })).toBeUndefined();
    expect(parseOrganization({})).toBeUndefined();
  });
});

describe("claim journal", () => {
  const ORG = "abcdef01-2345-6789-abcd-ef0123456789";
  const fresh = { grantId: "g1", requestId: "req-1" };

  const started = (): ClaimJournal => {
    const begun = beginClaim(undefined, { organization: ORG, fresh, current: true }, NOW);

    if (!begun.ok) throw new Error("claim did not start");

    return begun.journal;
  };

  it("blocks a second claim while one is in flight", () => {
    const journal = started();

    expect(beginClaim(journal, { organization: ORG, fresh, current: true }, NOW + 1)).toEqual({
      ok: false,
      error: "busy",
    });
    expect(
      beginClaim(journal, { organization: ORG, fresh, current: true }, NOW + CLAIM_LEASE_MS).ok,
    ).toBe(true);
  });

  it("resends an unanswered claim with the same ids, for the same organization only", () => {
    const open = settleClaim(started(), "req-1", "unknown").journal;

    expect(open).toMatchObject({ in_flight_until: 0, attempts: 1 });

    const retry = beginClaim(
      open,
      { organization: ORG, fresh: { grantId: "g9", requestId: "x" }, current: true },
      NOW + 5,
    );

    expect(retry).toMatchObject({
      ok: true,
      retry: true,
      journal: { grant_id: "g1", request_id: "req-1", attempts: 2 },
    });
    expect(beginClaim(open, { organization: "other", fresh, current: true }, NOW + 5)).toEqual({
      ok: false,
      error: "identity",
    });
  });

  it("starts fresh after the retry window, or answers expired without a fresh claim", () => {
    const open = settleClaim(started(), "req-1", "unknown").journal;
    const later = NOW + RETRY_WINDOW_MS;

    expect(beginClaim(open, { organization: ORG, fresh: undefined, current: true }, later)).toEqual(
      {
        ok: false,
        error: "expired",
      },
    );
    expect(beginClaim(open, { organization: "other", fresh, current: true }, later)).toMatchObject({
      ok: true,
      retry: false,
    });
  });

  it("closes on a definite answer; a resend's refusal keeps it open; already_used on a resend spent", () => {
    expect(settleClaim(started(), "req-1", "reset")).toEqual({ journal: undefined, spent: true });
    expect(settleClaim(started(), "req-1", "not_limited")).toEqual({
      journal: undefined,
      spent: false,
    });
    expect(settleClaim(started(), "req-1", "already_used").spent).toBe(false);

    const open = settleClaim(started(), "req-1", "unknown").journal;

    const resent = beginClaim(
      open,
      { organization: ORG, fresh: undefined, current: true },
      NOW + 5,
    );

    if (!resent.ok) throw new Error("resend refused");
    expect(settleClaim(resent.journal, "req-1", "already_used")).toEqual({
      journal: undefined,
      spent: true,
    });
    expect(settleClaim(resent.journal, "req-1", "rate_limited")).toMatchObject({
      journal: { request_id: "req-1" },
      spent: false,
    });
    // An answer to another request leaves the journal alone.
    expect(settleClaim(resent.journal, "other", "reset").journal).toBe(resent.journal);
  });

  it("refuses a fresh claim decided on a status read before the last claim activity", () => {
    expect(beginClaim(undefined, { organization: ORG, fresh, current: false }, NOW)).toEqual({
      ok: false,
      error: "stale",
    });
    // A resend does not depend on the status.
    const open = settleClaim(started(), "req-1", "unknown").journal;
    expect(beginClaim(open, { organization: ORG, fresh, current: false }, NOW + 5).ok).toBe(true);
  });

  it("tells a resend whose claim was answered meanwhile from one that expired", () => {
    expect(
      beginClaim(undefined, { organization: ORG, fresh: undefined, current: true }, NOW),
    ).toEqual({ ok: false, error: "settled" });
  });

  it("marks a pending claim in flight while a request of it runs", () => {
    const journal = started();
    expect(pendingClaimJson(journal, NOW + 1).in_flight).toBe(true);

    const open = settleClaim(journal, "req-1", "unknown").journal;
    expect(open === undefined ? undefined : pendingClaimJson(open, NOW + 1).in_flight).toBe(false);
  });

  it("sees an unanswered claim land in a later status", () => {
    const journal: ClaimJournal = { ...started(), resets_left: 2 };

    const later = (extra: Record<string, unknown>) => {
      const status = parse(usage(extra));

      if (status === undefined) throw new Error("bad status");

      return status;
    };

    expect(claimLanded(journal, later({ grants: [grant("g1", { resets_left: 1 })] }))).toBe(true);
    expect(claimLanded(journal, later({ grants: [grant("g1")] }))).toBe(false);
    expect(claimLanded(journal, later({ grants: [grant("g2", { resets_left: 0 })] }))).toBe(false);
    expect(
      claimLanded(journal, later({ cooldown_until: new Date(NOW + 60_000).toISOString() })),
    ).toBe(true);
    expect(
      claimLanded(journal, later({ cooldown_until: new Date(NOW - 60_000).toISOString() })),
    ).toBe(false);
    // An older journal without the count only goes by the cooldown.
    expect(claimLanded(started(), later({ grants: [grant("g1", { resets_left: 0 })] }))).toBe(
      false,
    );
    // Landed counts as spent only when the account is no longer at a limit.
    expect(landedAnswer(journal, later({ at_limit: false }))).toBe("already_used");
    expect(landedAnswer(journal, later({ at_limit: true }))).toBe("not_confirmed");
    // Once answered not_confirmed, the next resend sends the request after all.
    expect(landedAnswer({ ...journal, unconfirmed: true }, later({ at_limit: true }))).toBe(
      undefined,
    );
  });

  it("keeps a resend settled as not confirmed open, without counting it spent", () => {
    const open = settleClaim(started(), "req-1", "unknown").journal;

    const resent = beginClaim(
      open,
      { organization: ORG, fresh: undefined, current: true },
      NOW + 5,
    );

    if (!resent.ok) throw new Error("resend refused");
    expect(settleClaim(resent.journal, "req-1", "not_confirmed")).toEqual({
      journal: { ...resent.journal, in_flight_until: 0, unconfirmed: true },
      spent: false,
    });
  });

  it("holds one claim per organization across auth files", () => {
    const inFlight = started();
    const open = settleClaim(started(), "req-1", "unknown").journal;

    if (open === undefined) throw new Error("claim closed");

    const begin = (others: readonly ClaimJournal[], now = NOW + 5) =>
      beginClaim(undefined, { organization: ORG, fresh, current: true, others }, now);

    expect(begin([inFlight])).toEqual({ ok: false, error: "busy" });
    expect(begin([open])).toEqual({ ok: false, error: "busy" });
    expect(begin([{ ...open, organization: "other" }]).ok).toBe(true);
    // An open claim past its retry window no longer holds the organization.
    expect(begin([open], NOW + RETRY_WINDOW_MS).ok).toBe(true);
  });

  it("resends only the claim the caller saw", () => {
    const open = settleClaim(started(), "req-1", "unknown").journal;

    const resend = (requestId: string) =>
      beginClaim(
        open,
        { organization: ORG, fresh: undefined, resend: requestId, current: true },
        NOW + 5,
      );

    expect(resend("req-0")).toEqual({ ok: false, error: "settled" });
    expect(resend("req-1")).toMatchObject({ ok: true, retry: true });
  });
});

// --- routes ---------------------------------------------------------------------------------------------------------

const ORGANIZATION = "abcdef01-2345-6789-abcd-ef0123456789";

const CLAIM_URL = resetGrantClaimUrl(ORGANIZATION);

const GRANTS = "/v9/management/credentials/reset-grants";

const CLAIM = `${GRANTS}/claim`;

/** The current test's answers of the Anthropic endpoints. */
let statusReply: MockReply;

let profileReply: MockReply;

let claimReply: MockReply;

/** Runs once while the next status read or claim is on the wire (another tab acting meanwhile). */
type Hook = () => Promise<void>;

let onStatus: Hook | undefined;

let onClaim: Hook | undefined;

const once = async (hook: Hook | undefined): Promise<void> => {
  await hook?.();
};

const harness = makeHarness(
  routes({
    [`GET ${RESET_GRANT_STATUS_URL}`]: async () => {
      const hook = onStatus;
      onStatus = undefined;
      await once(hook);

      return statusReply;
    },
    [`GET ${CLAUDE_PROFILE_URL}`]: () => profileReply,
    [`POST ${CLAIM_URL}`]: async () => {
      const hook = onClaim;
      onClaim = undefined;
      await once(hook);

      return claimReply;
    },
    [`GET ${CLAUDE_USAGE_URL}`]: { status: 200, body: { five_hour: { utilization: 0 } } },
  }),
);

afterAll(async () => {
  await harness.dispose();
});

beforeEach(async () => {
  statusReply = { status: 200, body: usage() };
  profileReply = {
    status: 200,
    body: { account: { has_claude_max: true }, organization: { uuid: ORGANIZATION } },
  };
  claimReply = { status: 200, body: { result: "reset" } };
  onStatus = undefined;
  onClaim = undefined;
  harness.requests.length = 0;
  await resetControlPlane();
  // A claim left in flight by a test outlives the removal of its credential (`forget`) and would hold its organization.
  await runInDurableObject(controlPlane(), (_instance, state) => {
    state.storage.sql.exec("UPDATE credential_reset_grants SET claim = NULL");
  });
});

const INDEX = authIndexOf("claude-a.json");

const seed = async (name = "claude-a.json", file: Record<string, unknown> = claudeFile()) => {
  const result = await controlPlane().importAuthFile(name, JSON.stringify(file), {}, FULL_ACCESS);

  expect(result.ok).toBe(true);
};

const readGrants = (authIndex = INDEX, init?: RequestInit) =>
  harness.json(`${GRANTS}?auth_index=${authIndex}`, init);

const claim = (authIndex = INDEX) =>
  harness.json(CLAIM, jsonInit("POST", { auth_index: authIndex }));

const sent = (url: string) => harness.requests.filter((request) => request.url === url);

const decodeListed = Schema.decodeUnknownSync(
  Schema.Struct({ files: Schema.Array(CredentialEntry) }),
);

const listed = async (name = "claude-a.json") => {
  const { body } = await harness.json("/v9/management/credentials");

  return decodeListed(body).files.find((file) => file.name === name);
};

/** The grant mark the ControlPlane hands out now (what a status read started now would be stored under). */
const markOf = async (authIndex = INDEX) => {
  const target = await controlPlane().resetGrantTarget({ authIndex }, FULL_ACCESS);

  if (!target.ok) throw new Error("no reset grant target");

  return target.mark;
};

/** Starts a claim of `claude-a.json` as another tab would (in flight, unanswered). */
const beginElsewhere = async (requestId: string) => {
  const started = await controlPlane().beginResetGrantClaim(
    "claude-a.json",
    ORGANIZATION,
    { grantId: "g1", requestId, resetsLeft: 2 },
    await markOf(),
  );

  expect(started.ok).toBe(true);
};

const BUSY =
  "another reset of this Anthropic account is being used or awaits an answer, possibly from another auth file; check resets";

/** Puts the account in a model cooldown (a 429 reported for its lease). */
const coolDown = async (): Promise<void> => {
  const stub = controlPlane();
  const picked = await stub.pick({ providers: ["claude"], model: "claude-sonnet-4-5" });

  if (!picked.ok) throw new Error("pick failed");
  await stub.report(picked.lease, {
    success: false,
    httpStatus: 429,
    error: { message: "limit", retryable: true },
  });
};

describe("GET /credentials/reset-grants", () => {
  it("reads the status with the account's token and stores it on the entry", async () => {
    await seed();
    const { status, body } = await readGrants();

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      grants: { eligible: true, at_limit: true, claimable: "g1", grants: [{ id: "g1" }] },
    });
    expect(body).not.toHaveProperty("pending_claim");
    expect(JSON.stringify(body)).not.toContain("sk-ant-oat-secret-access");

    const [request] = sent(RESET_GRANT_STATUS_URL);
    expect(request?.headers.authorization).toBe("Bearer sk-ant-oat-secret-access");
    expect(request?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");

    // SAFETY: matched above.
    expect((await listed())?.reset_grants).toEqual((body as { grants: unknown }).grants);
  });

  it("answers 400, 404, 422 and 502 without leaking anything", async () => {
    await seed();
    await seed("qwen-a.json", {
      type: "qwen",
      access_token: "ya29.secret",
      expired: "2999-01-01T00:00:00Z",
    });

    expect(await harness.json(GRANTS)).toMatchObject({
      status: 400,
      body: { error: "auth_index is required" },
    });
    expect(await readGrants("ffffffffffffffff")).toMatchObject({
      status: 404,
      body: { error: "auth file not found" },
    });
    expect(await readGrants(authIndexOf("qwen-a.json"))).toMatchObject({
      status: 422,
      body: { error: "reset grants are only available for Claude accounts, not qwen" },
    });
    expect(harness.requests).toHaveLength(0);

    statusReply = { status: 500, body: { error: "secret-bearing upstream body" } };
    const failed = await readGrants();

    expect(failed).toMatchObject({
      status: 502,
      body: { error: "could not read the reset grants from Anthropic" },
    });
    expect(JSON.stringify(failed.body)).not.toContain("secret");

    statusReply = { status: 200, body: usage({ grants: [grant("g1"), grant("g1")] }) };
    expect((await readGrants()).status).toBe(502);
    expect((await listed())?.reset_grants).toBeUndefined();
  });

  it("is refused to non-admins", async () => {
    await seed();

    // A plain member reaches only their own private accounts: a shared one is as good as absent.
    const response = await harness.call(`${GRANTS}?auth_index=${INDEX}`, {
      auth: await token("other@example.com"),
    });

    expect(response.status).toBe(404);
    await response.body?.cancel();
    expect(harness.requests).toHaveLength(0);
  });
});

describe("POST /credentials/reset-grants/claim", () => {
  it("re-reads the status, claims the chosen grant, clears cooldowns and checks the quota again", async () => {
    await seed();
    await coolDown();
    expect((await listed())?.cooldowns).toHaveLength(1);

    const { status, body } = await claim();

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      outcome: "reset",
      retried: false,
      cooldown_cleared: true,
      report: { windows: [{ id: "five_hour", used_percent: 0 }] },
    });
    expect(body).not.toHaveProperty("pending_claim");

    const [request] = sent(CLAIM_URL);
    const payload = request?.json();

    expect(payload).toMatchObject({ program: "cedar_ember", grant_id: "g1" });
    expect(payload?.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(request?.headers.authorization).toBe("Bearer sk-ant-oat-secret-access");
    expect(JSON.stringify(body)).not.toContain("sk-ant-oat");

    const entry = await listed();
    expect(entry?.cooldowns).toEqual([]);
    // The status read before the claim, then the quota check's own read.
    expect(sent(RESET_GRANT_STATUS_URL)).toHaveLength(2);
    expect(entry?.reset_grants).toBeDefined();
  });

  it("sends nothing when no grant is claimable", async () => {
    await seed();
    statusReply = { status: 200, body: usage({ grants: [grant("g1", { resets_left: 0 })] }) };
    const { status, body } = await claim();

    expect(status).toBe(200);
    expect(body).toMatchObject({
      outcome: "none_available",
      cooldown_cleared: false,
      grants: { blocked_by: "none_left" },
    });
    expect(sent(CLAIM_URL)).toHaveLength(0);
    expect(sent(CLAUDE_PROFILE_URL)).toHaveLength(0);
  });

  it("passes Anthropic's refusals on and keeps cooldowns", async () => {
    await seed();
    await coolDown();

    for (const [reply, outcome] of [
      [{ status: 200, body: { result: "not_limited" } }, "not_limited"],
      [{ status: 200, body: { result: "cooldown" } }, "cooldown"],
      [{ status: 429 }, "rate_limited"],
      [{ status: 401 }, "auth_error"],
    ] as const) {
      claimReply = reply;
      const { status, body } = await claim();

      expect(status, outcome).toBe(200);
      expect(body, outcome).toMatchObject({
        outcome,
        cooldown_cleared: false,
        grants: { claimable: "g1" },
      });
      expect(body, outcome).not.toHaveProperty("pending_claim");
    }

    expect((await listed())?.cooldowns).toHaveLength(1);
  });

  it("resends an unanswered claim with the same request id instead of spending another reset", async () => {
    await seed();
    claimReply = { status: 502, body: "upstream hiccup" };
    const first = await claim();

    expect(first.body).toMatchObject({
      outcome: "unknown",
      retried: false,
      pending_claim: { grant_id: "g1" },
    });

    // Reading the status shows the open claim.
    expect((await readGrants()).body).toMatchObject({ pending_claim: { grant_id: "g1" } });

    const firstId = sent(CLAIM_URL)[0]?.json().request_id;

    // A status read failing now must not block the resend.
    statusReply = { status: 500 };
    claimReply = { status: 200, body: { result: "already_used" } };
    harness.requests.length = 0;
    const second = await claim();

    expect(second.body).toMatchObject({
      outcome: "already_used",
      retried: true,
      cooldown_cleared: true,
    });
    expect(second.body).not.toHaveProperty("pending_claim");

    const claims = sent(CLAIM_URL).map((request) => request.json());
    expect(claims).toEqual([{ program: "cedar_ember", grant_id: "g1", request_id: firstId }]);
    // The resend's read and the quota check's after the reset (both failed, tolerated).
    expect(sent(RESET_GRANT_STATUS_URL)).toHaveLength(2);
  });

  it("refuses a resend for another organization and a claim while one is in flight", async () => {
    await seed();
    claimReply = { transportError: true };
    expect((await claim()).body).toMatchObject({ outcome: "unknown", pending_claim: {} });

    profileReply = {
      status: 200,
      body: { organization: { uuid: "00000000-0000-4000-8000-000000000000" } },
    };
    expect(await claim()).toMatchObject({
      status: 409,
      body: { error: "the unanswered reset was sent for another organization" },
    });

    await resetControlPlane();
    await seed();
    profileReply = { status: 200, body: { organization: { uuid: ORGANIZATION } } };

    await beginElsewhere("other-tab");
    harness.requests.length = 0;
    expect((await readGrants()).body).toMatchObject({ pending_claim: { in_flight: true } });
    harness.requests.length = 0;
    expect(await claim()).toMatchObject({ status: 409, body: { error: BUSY } });
    // Refused before any upstream call.
    expect(harness.requests).toHaveLength(0);
  });

  it("answers 502 when the organization cannot be read, without sending a claim", async () => {
    await seed();
    profileReply = { status: 500 };
    expect(await claim()).toMatchObject({
      status: 502,
      body: { error: "could not read the account's organization from Anthropic" },
    });
    expect(sent(CLAIM_URL)).toHaveLength(0);
  });

  it("drops grants and an open claim when a re-login replaces the tokens", async () => {
    await seed();
    claimReply = { status: 500 };
    await claim();
    expect((await listed())?.reset_grants).toBeDefined();

    await seed("claude-a.json", claudeFile({ access_token: "sk-ant-oat-other-account" }));
    expect((await listed())?.reset_grants).toBeUndefined();

    claimReply = { status: 200, body: { result: "reset" } };
    expect((await claim()).body).toMatchObject({ outcome: "reset", retried: false });
  });

  it("is refused to non-admins and to cross-site forms", async () => {
    await seed();

    const denied = await harness.call(CLAIM, {
      ...jsonInit("POST", { auth_index: INDEX }),
      auth: await token("other@example.com"),
    });

    expect(denied.status).toBe(404);
    await denied.body?.cancel();

    const forged = await exports.default.fetch(
      new Request(`http://localhost${CLAIM}`, {
        method: "POST",
        headers: {
          origin: "https://evil.test",
          "sec-fetch-site": "cross-site",
          "content-type": "text/plain",
        },
        body: JSON.stringify({ auth_index: INDEX }),
      }),
    );

    expect(forged.status).toBe(403);
    await forged.body?.cancel();
    expect(harness.requests).toHaveLength(0);
  });
});

describe("claim races and failures", () => {
  const CHANGED = "the account was replaced while its resets were being read; check resets again";

  it("refuses a claim decided on a status that another tab's reset overtook", async () => {
    await seed();
    // Another tab's claim starts and is answered while this claim's status read is on the wire.
    onStatus = async () => {
      await beginElsewhere("other-tab");
      await controlPlane().settleResetGrantClaim("claude-a.json", "other-tab", "reset");
    };

    expect(await claim()).toMatchObject({
      status: 409,
      body: { error: "the resets changed while they were being read; check resets and try again" },
    });
    expect(sent(CLAIM_URL)).toHaveLength(0);

    // Claiming again reads the status again and goes through.
    harness.requests.length = 0;
    expect((await claim()).body).toMatchObject({ outcome: "reset", retried: false });
    expect(sent(CLAIM_URL)).toHaveLength(1);
  });

  it("refuses claims on a disabled account; reads stay allowed", async () => {
    await seed();
    await controlPlane().setCredentialDisabled("claude-a.json", true, FULL_ACCESS);

    expect(await claim()).toMatchObject({
      status: 409,
      body: { error: "this account is disabled; enable it to use a reset" },
    });
    expect(harness.requests).toHaveLength(0);
    expect(
      await controlPlane().beginResetGrantClaim(
        "claude-a.json",
        ORGANIZATION,
        { grantId: "g1", requestId: "r" },
        await markOf(),
      ),
    ).toEqual({ ok: false, error: "disabled" });
    expect((await readGrants()).status).toBe(200);
  });

  it("keeps the newer status and drops one read across a re-login or a re-creation", async () => {
    await seed();
    const mark = await markOf();
    const newer = parse(usage());
    const older = parseResetGrantStatus(usage({ grants: [] }), NOW - 1000);

    if (newer === undefined || older === undefined) throw new Error("bad status");

    const record = (status: ResetGrantStatus) =>
      controlPlane().recordResetGrantStatus("claude-a.json", status, mark);

    expect(await record(newer)).toBe("stored");
    expect(await record(older)).toBe("older");
    expect((await listed())?.reset_grants?.checked_at).toBe(newer.checked_at);

    // A re-login lands while the read is on the wire: nothing from the previous tokens is kept.
    onStatus = () =>
      seed("claude-a.json", claudeFile({ access_token: "sk-ant-oat-other-account" }));
    expect(await readGrants()).toMatchObject({ status: 409, body: { error: CHANGED } });
    expect((await listed())?.reset_grants).toBeUndefined();
    expect(await record(newer)).toBe("replaced");

    // Removed and re-created under the same name during a claim's read: no claim is sent.
    onStatus = async () => {
      await controlPlane().removeCredential("claude-a.json", FULL_ACCESS);
      await seed();
    };

    harness.requests.length = 0;
    expect(await claim()).toMatchObject({ status: 409, body: { error: CHANGED } });
    expect(sent(CLAIM_URL)).toHaveLength(0);
    expect((await listed())?.reset_grants).toBeUndefined();
  });

  it("follows no redirect: a 3xx read fails, a 3xx or non-JSON claim answer is unknown", async () => {
    await seed();
    statusReply = { status: 302, headers: { location: "https://elsewhere.test/" } };
    expect((await readGrants()).status).toBe(502);

    statusReply = { status: 200, body: usage() };
    claimReply = { status: 307, headers: { location: "https://elsewhere.test/" } };
    expect((await claim()).body).toMatchObject({
      outcome: "unknown",
      pending_claim: { grant_id: "g1", in_flight: false },
    });

    await resetControlPlane();
    await seed();
    claimReply = { status: 200, body: "<html>reset</html>" };
    expect((await claim()).body).toMatchObject({ outcome: "unknown", pending_claim: {} });

    expect(harness.requests.length).toBeGreaterThan(0);
    expect(harness.requests.filter((request) => request.redirect !== "manual")).toEqual([]);
  });

  it("does not count already_used on a first claim as spent", async () => {
    await seed();
    await coolDown();
    claimReply = { status: 200, body: { result: "already_used" } };
    const { body } = await claim();

    expect(body).toMatchObject({
      outcome: "already_used",
      retried: false,
      cooldown_cleared: false,
    });
    expect(body).not.toHaveProperty("pending_claim");
    expect(body).not.toHaveProperty("report");
    expect((await listed())?.cooldowns).toHaveLength(1);
  });

  it("resends the claim of a tab that died once its lease expires", async () => {
    await seed();
    await beginElsewhere("crashed-tab");
    expect(await claim()).toMatchObject({ status: 409, body: { error: BUSY } });

    await runInDurableObject(controlPlane(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE credential_reset_grants SET claim = json_set(claim, '$.in_flight_until', 0)",
      );
    });
    expect((await readGrants()).body).toMatchObject({ pending_claim: { in_flight: false } });

    harness.requests.length = 0;
    expect((await claim()).body).toMatchObject({ outcome: "reset", retried: true });
    expect(sent(CLAIM_URL).map((request) => request.json())).toEqual([
      { program: "cedar_ember", grant_id: "g1", request_id: "crashed-tab" },
    ]);
  });

  it("settles a resend as spent without sending when the status shows the reset landed", async () => {
    await seed();
    await coolDown();
    claimReply = { status: 504 };
    expect((await claim()).body).toMatchObject({ outcome: "unknown" });

    statusReply = {
      status: 200,
      body: usage({ at_limit: false, grants: [grant("g1", { resets_left: 1 })] }),
    };
    harness.requests.length = 0;
    const { body } = await claim();

    expect(body).toMatchObject({ outcome: "already_used", retried: true, cooldown_cleared: true });
    expect(body).not.toHaveProperty("pending_claim");
    expect(sent(CLAIM_URL)).toHaveLength(0);
  });

  it("answers a landed-looking resend as not confirmed while the account is still at a limit, then resends", async () => {
    await seed();
    await coolDown();
    claimReply = { status: 504 };
    expect((await claim()).body).toMatchObject({ outcome: "unknown" });
    const firstId = sent(CLAIM_URL)[0]?.json().request_id;

    statusReply = { status: 200, body: usage({ grants: [grant("g1", { resets_left: 1 })] }) };
    harness.requests.length = 0;
    const { body } = await claim();

    expect(body).toMatchObject({
      outcome: "not_confirmed",
      retried: true,
      cooldown_cleared: false,
      grants: { at_limit: true },
    });
    expect(body).toMatchObject({ pending_claim: { grant_id: "g1", in_flight: false } });
    expect(body).not.toHaveProperty("report");
    expect(sent(CLAIM_URL)).toHaveLength(0);
    expect((await listed())?.cooldowns).toHaveLength(1);
    // The claim stays open: the next click sends the same request.
    claimReply = { status: 200, body: { result: "already_used" } };
    harness.requests.length = 0;
    expect((await claim()).body).toMatchObject({ outcome: "already_used", retried: true });
    expect(sent(CLAIM_URL).map((request) => request.json().request_id)).toEqual([firstId]);
  });

  it("holds one claim per organization across auth files", async () => {
    await seed();
    await seed("claude-b.json", claudeFile({ access_token: "sk-ant-oat-second-file" }));
    const indexB = authIndexOf("claude-b.json");

    // An unanswered claim of one file blocks the other file of the same organization.
    claimReply = { status: 504 };
    expect((await claim()).body).toMatchObject({ outcome: "unknown", pending_claim: {} });
    harness.requests.length = 0;
    expect(await claim(indexB)).toMatchObject({ status: 409, body: { error: BUSY } });
    expect(sent(CLAIM_URL)).toHaveLength(0);

    // Another organization is not blocked.
    const other = await controlPlane().beginResetGrantClaim(
      "claude-b.json",
      "00000000-0000-4000-8000-000000000000",
      { grantId: "g1", requestId: "other-org" },
      await markOf(indexB),
    );

    expect(other).toMatchObject({ ok: true, retry: false });
  });

  it("keeps a claim in flight through a re-login or a removal, and records its answer", async () => {
    await seed();
    await beginElsewhere("on-the-wire");

    // A re-login into the same organization while the request is on the wire: still busy.
    await seed("claude-a.json", claudeFile({ access_token: "sk-ant-oat-relogin" }));
    harness.requests.length = 0;
    expect(await claim()).toMatchObject({ status: 409, body: { error: BUSY } });
    expect(sent(CLAIM_URL)).toHaveLength(0);

    // Removed, then the organization is added again under another name: still busy.
    await controlPlane().removeCredential("claude-a.json", FULL_ACCESS);
    await seed("claude-b.json", claudeFile({ access_token: "sk-ant-oat-second-file" }));
    const indexB = authIndexOf("claude-b.json");

    expect(await claim(indexB)).toMatchObject({
      status: 409,
      body: { error: expect.stringContaining("removed auth file") },
    });

    // The answer of the request on the wire is still recorded, which frees the organization.
    expect(
      await controlPlane().settleResetGrantClaim("claude-a.json", "on-the-wire", "reset"),
    ).toEqual({ cooldownCleared: false });
    harness.requests.length = 0;
    expect((await claim(indexB)).body).toMatchObject({ outcome: "reset", retried: false });
    expect(sent(CLAIM_URL)).toHaveLength(1);
  });

  it("keeps a claim in flight through a batch delete, like a single delete", async () => {
    await seed();
    await readGrants();
    await beginElsewhere("on-the-wire");
    expect(await controlPlane().removeCredentials(["claude-a.json"], FULL_ACCESS)).toEqual([
      "claude-a.json",
    ]);

    // The status is gone with the credential; the claim in flight still holds its organization.
    await seed();
    expect((await listed())?.reset_grants).toBeUndefined();
    harness.requests.length = 0;
    expect(await claim()).toMatchObject({ status: 409, body: { error: BUSY } });
    expect(sent(CLAIM_URL)).toHaveLength(0);
  });

  it("refuses a claim decided on a status read before another file's claim of the organization settled", async () => {
    await seed();
    await seed("claude-b.json", claudeFile({ access_token: "sk-ant-oat-second-file" }));
    const indexB = authIndexOf("claude-b.json");

    // claude-a's claim starts and is answered (its journal is gone) while claude-b's status read is on the wire.
    onStatus = async () => {
      await beginElsewhere("file-a");
      await controlPlane().settleResetGrantClaim("claude-a.json", "file-a", "reset");
    };

    harness.requests.length = 0;
    expect(await claim(indexB)).toMatchObject({
      status: 409,
      body: { error: "the resets changed while they were being read; check resets and try again" },
    });
    expect(sent(CLAIM_URL)).toHaveLength(0);
  });

  it("refuses a resend when the open claim is not the one it saw", async () => {
    await seed();
    claimReply = { status: 500 };
    await claim();
    const seen = String(sent(CLAIM_URL)[0]?.json().request_id);

    // Meanwhile another tab's resend gets the answer, and a new claim is started and left unanswered.
    onStatus = async () => {
      const stub = controlPlane();
      await stub.beginResetGrantClaim(
        "claude-a.json",
        ORGANIZATION,
        undefined,
        await markOf(),
        seen,
      );
      await stub.settleResetGrantClaim("claude-a.json", seen, "already_used");
      await beginElsewhere("newer-claim");
      await stub.settleResetGrantClaim("claude-a.json", "newer-claim", "unknown");
    };

    harness.requests.length = 0;
    expect(await claim()).toMatchObject({
      status: 409,
      body: { error: "the unanswered reset was already answered in another tab; check resets" },
    });
    expect(sent(CLAIM_URL)).toHaveLength(0);
  });

  it("tells a resend that another tab already got the answer", async () => {
    await seed();
    claimReply = { status: 500 };
    await claim();
    const requestId = String(sent(CLAIM_URL)[0]?.json().request_id);

    onStatus = async () => {
      await controlPlane().beginResetGrantClaim(
        "claude-a.json",
        ORGANIZATION,
        undefined,
        await markOf(),
      );
      await controlPlane().settleResetGrantClaim("claude-a.json", requestId, "reset");
    };

    harness.requests.length = 0;
    expect(await claim()).toMatchObject({
      status: 409,
      body: { error: "the unanswered reset was already answered in another tab; check resets" },
    });
    expect(sent(CLAIM_URL)).toHaveLength(0);
  });

  it("returns Anthropic's answer with a warning when Commissary cannot record it", async () => {
    await seed();

    const rename = (from: string, to: string) =>
      runInDurableObject(controlPlane(), (_instance, state) => {
        state.storage.sql.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
      });

    onClaim = () => rename("credential_reset_grants", "hidden_reset_grants");

    try {
      const { status, body } = await claim();

      expect(status).toBe(200);
      expect(body).toMatchObject({
        outcome: "reset",
        cooldown_cleared: false,
        warning: expect.stringContaining("could not record the answer"),
      });
    } finally {
      await rename("hidden_reset_grants", "credential_reset_grants");
    }
  });

  it.effect("gives up on an unanswered claim after 25 s and keeps it open for a resend", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seed());
      yield* TestClock.setTime(NOW);

      const outbound = mockHttp(
        routes({
          [`GET ${RESET_GRANT_STATUS_URL}`]: { status: 200, body: usage() },
          [`GET ${CLAUDE_PROFILE_URL}`]: {
            status: 200,
            body: { organization: { uuid: ORGANIZATION } },
          },
          // Never answers.
          [`POST ${CLAIM_URL}`]: () => new Promise<MockReply>(() => undefined),
        }),
      );

      const fiber = yield* Effect.forkChild(
        claimResetGrant({ authIndex: INDEX }, FULL_ACCESS).pipe(
          Effect.provide(outbound.layer),
          Effect.provideContext(envContext(env)),
        ),
      );

      while (!outbound.requests.some((request) => request.url === CLAIM_URL))
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));

      yield* TestClock.adjust("24 seconds");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);

      assert.deepInclude(result, { kind: "claimed", outcome: "unknown", retried: false });
      assert.deepInclude(result.kind === "claimed" ? result.pending : undefined, {
        grant_id: "g1",
        in_flight: false,
      });
    }).pipe(Effect.provideService(CurrentOrg, GLOBAL_ORG)),
  );
});

describe("quota check", () => {
  it("stores the grant status read beside the usage, and tolerates its failure", async () => {
    await seed();

    const checked = await harness.json(
      "/v9/management/credentials/quota",
      jsonInit("POST", { name: "claude-a.json" }),
    );

    expect(checked.status).toBe(200);
    expect((await listed())?.reset_grants).toMatchObject({ claimable: "g1" });

    statusReply = { status: 500 };

    const failed = await harness.json(
      "/v9/management/credentials/quota",
      jsonInit("POST", { name: "claude-a.json" }),
    );

    expect(failed.body).toMatchObject({ report: { windows: [{ id: "five_hour" }] } });
    expect(failed.body).not.toHaveProperty("report.error");
    // The last good status is kept.
    expect((await listed())?.reset_grants).toMatchObject({ claimable: "g1" });
    expect(harness.requests.filter((request) => request.redirect !== "manual")).toEqual([]);
  });

  it.live(
    "costs a sweep three Anthropic calls per Claude account, two while the grants are recent",
    () =>
      Effect.gen(function* () {
        const names = ["claude-a.json", "claude-b.json", "claude-c.json", "claude-d.json"];

        yield* Effect.promise(async () => {
          for (const name of names)
            await seed(name, claudeFile({ access_token: `sk-ant-oat-${name.slice(0, 8)}` }));
        });

        let open = 0;
        let peak = 0;

        const outbound = mockHttp(async (request) => {
          open += 1;
          peak = Math.max(peak, open);
          await new Promise((resolve) => setTimeout(resolve, 5));
          open -= 1;

          if (request.url === CLAUDE_USAGE_URL) return { status: 200, body: { five_hour: {} } };

          if (request.url === CLAUDE_PROFILE_URL) return { status: 200, body: {} };

          // claude-d is not eligible: its grants are not read again by the sweep either.
          return request.headers.authorization?.includes("claude-d") === true
            ? { status: 200, body: { cedar_ember: { eligible: false } } }
            : { status: 200, body: usage() };
        });

        const sweep = runQuotaSweep.pipe(
          Effect.provide(outbound.layer),
          Effect.provideContext(envContext(env)),
        );

        assert.deepStrictEqual(yield* sweep, { checked: 4, failed: 0 });
        assert.strictEqual(outbound.requests.length, 3 * names.length);
        // Two checks at a time, three calls each: never more than six connections waiting at once.
        assert.isAtMost(peak, 6);

        // Every grant read is recent now: the next sweep skips them all.
        outbound.requests.length = 0;
        assert.deepStrictEqual(yield* sweep, { checked: 4, failed: 0 });
        assert.strictEqual(outbound.requests.length, 2 * names.length);
        assert.isFalse(outbound.requests.some((request) => request.url === RESET_GRANT_STATUS_URL));

        // Six hours later the eligible accounts are read again, the ineligible one is not.
        yield* Effect.promise(() =>
          runInDurableObject(controlPlane(), (_instance, state) => {
            state.storage.sql.exec(
              "UPDATE credential_reset_grants SET status = json_set(status, '$.checked_at', ?)",
              new Date(Date.now() - 6 * 3_600_000).toISOString(),
            );
          }),
        );
        outbound.requests.length = 0;
        assert.deepStrictEqual(yield* sweep, { checked: 4, failed: 0 });
        assert.strictEqual(outbound.requests.length, 3 * 3 + 2);

        // After a day the ineligible account is read again too (new grants can make it eligible).
        yield* Effect.promise(() =>
          runInDurableObject(controlPlane(), (_instance, state) => {
            state.storage.sql.exec(
              "UPDATE credential_reset_grants SET status = json_set(status, '$.checked_at', ?)",
              new Date(Date.now() - 24 * 3_600_000).toISOString(),
            );
          }),
        );
        outbound.requests.length = 0;
        assert.deepStrictEqual(yield* sweep, { checked: 4, failed: 0 });
        assert.strictEqual(outbound.requests.length, 3 * names.length);

        // A manual check always reads the grants.
        outbound.requests.length = 0;
        yield* Effect.promise(() =>
          harness.json(
            "/v9/management/credentials/quota",
            jsonInit("POST", { name: "claude-a.json" }),
          ),
        );
        assert.strictEqual(sent(RESET_GRANT_STATUS_URL).length, 1);
      }).pipe(Effect.provideService(CurrentOrg, GLOBAL_ORG)),
  );
});

// --- contract -------------------------------------------------------------------------------------------------------

const fetchVia =
  (target: Harness): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    return await target.call(`${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      ...(request.body === null ? {} : { body: await request.text() }),
    });
  };

const client = HttpApiClient.make(ManagementApi, { baseUrl: "https://commissary.test" });

const through = (target: Harness) =>
  Effect.provide(
    Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetchVia(target))),
  );

describe("reset grant contract", () => {
  it.effect("decodes the status, a claim and the entry's reset_grants", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seed());
      const api = yield* client;
      const view = yield* api.credentials.resetGrants({ query: { auth_index: INDEX } });

      assert.strictEqual(view.grants.claimable, "g1");
      claimReply = { status: 500 };
      const answer = yield* api.credentials.claimResetGrant({ payload: { auth_index: INDEX } });

      assert.strictEqual(answer.outcome, "unknown");
      assert.strictEqual(answer.pending_claim?.grant_id, "g1");

      const { files } = yield* api.credentials.list();

      assert.strictEqual(files[0]?.reset_grants?.claimable, "g1");

      const missing = yield* Effect.flip(
        api.credentials.claimResetGrant({ payload: { auth_index: "ffffffffffffffff" } }),
      );

      assert.instanceOf(missing, ManagementError);
      assert.strictEqual(missing.error, "auth file not found");
    }).pipe(through(harness)),
  );
});
