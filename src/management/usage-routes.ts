/**
 * Usage observability routes (`/v8/management/observability/usage/*`).
 *
 * Go source: internal/api/server_management_v8.go (route table), internal/api/handlers/management/usage.go
 * (`GetUsageQueue`). Records are read from D1 (`src/usage/d1.ts`) instead of
 * the in-process RESP queue. `records`, `summary` and `series` are Workers additions that expose the persisted history
 * (`series`: requests/failures/tokens per key × UTC hour or day bucket for the panel's quota-window bars; `since` is
 * required, `until` defaults to now, hour ranges are capped at 31 days and day ranges at 400).
 *
 * Deviations: `queue` pops from the records not yet exported (at most 1000 per call) and the export payload carries
 * the Access principal as `api_key`. Credentials appear only as the keyed `auth_index` (`group_by=auth` keys, the
 * export's `auth_index`, the `auth_index` filter); the stored credential id is never answered, and the old `auth_id`
 * filter is refused (400) rather than ignored. Go's `GET /observability/usage/api-keys` (`GetAPIKeyUsage`, api_key_usage.go,
 * per-key counters for the upstream panel) is not ported: the Keys page's `GET /api-keys` carries the same counters.
 * `summary`, `series` and `records` carry the cost stored on each record (`cost_micros`, ADR 0024) and `unpriced`
 * lists the provider and model pairs that had no price. Every route reads the records of the request's org only (ADR 0021).
 *
 * Members (ADR 0022): `member` and `team` filter by member id or by a team's members, `group_by=member` groups the
 * summary by member id. A plain member may read `records`, `summary` and `series` (`access/policy.ts`), and only their
 * own records: by their member id, or their Access principal for records from before members existed.
 */
import { Clock, Effect } from "effect";
import { HttpRouter } from "effect/http";
import { AccessPrincipal } from "../access/principal.ts";
import { WorkerEnv } from "../platform/env.ts";
import { CurrentOrg } from "../platform/org.ts";
import { currentAuthIndexer } from "./auth-index.ts";
import {
  BUCKET_MS,
  GROUP_BY,
  type GroupBy,
  listUsageRecords,
  MAX_QUEUE_COUNT,
  MAX_SERIES_RANGE_DAYS,
  popUsageQueue,
  rowToPayload,
  SERIES_BUCKETS,
  SERIES_GROUP_BY,
  type SeriesBucket,
  type SeriesGroupBy,
  summarizeUsage,
  summarizeUsageSeries,
  type UsageFilter,
  unpricedModels,
} from "../usage/d1.ts";
import { controlPlane, handled, jsonReply, queryParams, replyError } from "./http.ts";
import { viewerOf } from "./viewer.ts";

const BASE = "/v8/management/observability/usage";

/** The D1 database, or a 503 when the `USAGE` binding is missing. */
const usageDb = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const db: D1Database | undefined = env.USAGE;

  if (db === undefined) return yield* replyError(503, "usage store unavailable");

  return db;
});

/** D1 failures are logged without details and answered with a generic 502. */
const query = <A>(label: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause.message : "unknown error"),
  }).pipe(
    Effect.catch((message) =>
      Effect.logError(`usage ${label} failed: ${message}`).pipe(
        Effect.andThen(Effect.fail(replyError(502, "usage store unavailable"))),
      ),
    ),
  );

// --- queue ---------------------------------------------------------------------------------------------------------

/** `parseUsageQueueCount`: empty means 1; anything but a positive integer is a 400. */
const parseCount = (raw: string | null): number | undefined => {
  const value = (raw ?? "").trim();

  if (value === "") return 1;

  if (!/^[+-]?\d+$/.test(value)) return undefined;
  const count = Number(value);

  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
};

/** `GetUsageQueue`: pops the oldest unexported records. */
const usageQueue = Effect.gen(function* () {
  const params = yield* queryParams;
  const count = parseCount(params.get("count"));

  if (count === undefined) return yield* replyError(400, "count must be a positive integer");
  const db = yield* usageDb;
  const org = yield* CurrentOrg;
  const now = yield* Clock.currentTimeMillis;

  const rows = yield* query("queue", () =>
    popUsageQueue(db, org, Math.min(count, MAX_QUEUE_COUNT), now),
  );

  const authIndexOf = yield* currentAuthIndexer;

  return jsonReply(
    200,
    rows.map((row) => rowToPayload(row, authIndexOf)),
  );
});

// --- records and summary -------------------------------------------------------------------------------------------

/** Epoch milliseconds or an ISO 8601 date/time. */
const parseTime = (raw: string): number | undefined => {
  const value = raw.trim();

  if (/^\d+$/.test(value)) {
    const ms = Number(value);

    return Number.isSafeInteger(ms) ? ms : undefined;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? undefined : parsed;
};

const optional = (params: URLSearchParams, name: string): string | undefined => {
  const value = params.get(name)?.trim() ?? "";

  return value === "" ? undefined : value;
};

const parseFilter = (params: URLSearchParams) =>
  Effect.gen(function* () {
    const filter: { -readonly [K in keyof UsageFilter]: UsageFilter[K] } = {};

    for (const name of ["since", "until"] as const) {
      const raw = optional(params, name);

      if (raw === undefined) continue;
      const time = parseTime(raw);

      if (time === undefined)
        return yield* replyError(400, `${name} must be epoch milliseconds or an ISO 8601 time`);
      filter[name] = time;
    }

    const provider = optional(params, "provider");
    const model = optional(params, "model");
    const principal = optional(params, "principal");
    const authIndex = optional(params, "auth_index");

    // Credential ids are not published any more; a stale client must not silently get unfiltered totals.
    if (params.has("auth_id")) return yield* replyError(400, "auth_id was replaced by auth_index");

    if (provider !== undefined) filter.provider = provider.toLowerCase();

    if (model !== undefined) filter.model = model;

    if (principal !== undefined) filter.principal = principal;

    const member = optional(params, "member");
    const team = optional(params, "team");

    if (member !== undefined) filter.memberIds = [member];

    if (team !== undefined) {
      const ids = yield* controlPlane("teamMemberIds", (stub) => stub.teamMemberIds(team));

      if (ids === undefined) return yield* replyError(404, "team_not_found");
      const members = [...ids];

      // Both: the member, if they are in the team.
      filter.memberIds = member === undefined ? members : members.filter((id) => id === member);
    }

    // A plain member reads only their own records, whatever they asked for.
    const identity = yield* AccessPrincipal;

    if (!identity.platformAdmin && identity.role === "member")
      filter.own = { memberId: identity.memberId, principalId: identity.principalId };

    if (authIndex !== undefined) {
      filter.authIndex = authIndex.toLowerCase();

      // A live credential narrows D1 to its id directly; only other indexes read the distinct ids (`resolveAuthIds`).
      const live = yield* controlPlane("credentialIdOfAuthIndex", (stub) =>
        stub.credentialIdOfAuthIndex(authIndex.toLowerCase(), viewerOf(identity)),
      );

      if (live !== undefined) filter.liveAuthId = live;
    }

    const failed = optional(params, "failed");

    if (failed !== undefined) {
      if (failed !== "true" && failed !== "false")
        return yield* replyError(400, "failed must be true or false");
      filter.failed = failed === "true";
    }

    return filter;
  });

const parseLimit = (params: URLSearchParams) =>
  Effect.gen(function* () {
    const raw = optional(params, "limit");

    if (raw === undefined) return undefined;
    const limit = Number(raw);

    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit <= 0) {
      return yield* replyError(400, "limit must be a positive integer");
    }

    return limit;
  });

/** `GET /records`: newest first, `before` continues from `next_before`. */
const usageRecords = Effect.gen(function* () {
  const params = yield* queryParams;
  const filter = yield* parseFilter(params);
  const limit = yield* parseLimit(params);
  const before = optional(params, "before");
  const db = yield* usageDb;
  const org = yield* CurrentOrg;
  const authIndexOf = yield* currentAuthIndexer;

  const page = yield* query("records", () =>
    listUsageRecords(
      db,
      org,
      {
        ...filter,
        ...(limit === undefined ? {} : { limit }),
        ...(before === undefined ? {} : { before }),
      },
      authIndexOf,
    ),
  );

  return jsonReply(200, {
    records: page.rows.map((row) => rowToPayload(row, authIndexOf)),
    ...(page.nextBefore === undefined ? {} : { next_before: page.nextBefore }),
  });
});

/** `GET /summary`: token totals (v2 breakdown buckets) overall and per `group_by`. */
const usageSummary = Effect.gen(function* () {
  const params = yield* queryParams;
  const filter = yield* parseFilter(params);
  const limit = yield* parseLimit(params);
  const groupBy = optional(params, "group_by") ?? "model";

  // SAFETY: widening the literal tuple to string for the membership test; it is only read.
  if (!(GROUP_BY as ReadonlyArray<string>).includes(groupBy)) {
    return yield* replyError(400, `group_by must be one of ${GROUP_BY.join(", ")}`);
  }

  const db = yield* usageDb;
  const org = yield* CurrentOrg;
  const authIndexOf = yield* currentAuthIndexer;

  const summary = yield* query("summary", () =>
    summarizeUsage(
      db,
      org,
      {
        ...filter,
        // SAFETY: groupBy was checked against GROUP_BY above.
        groupBy: groupBy as GroupBy,
        ...(limit === undefined ? {} : { limit }),
      },
      authIndexOf,
    ),
  );

  return jsonReply(200, { group_by: groupBy, totals: summary.totals, groups: summary.groups });
});

/** `GET /unpriced`: the provider and model pairs with unpriced requests, the busiest first. */
const usageUnpriced = Effect.gen(function* () {
  const params = yield* queryParams;
  const scoped = new URLSearchParams();

  for (const name of [
    "since",
    "until",
    "provider",
    "model",
    "principal",
    "member",
    "team",
    "auth_index",
  ]) {
    const value = params.get(name);

    if (value !== null) scoped.set(name, value);
  }

  const filter = yield* parseFilter(scoped);
  const db = yield* usageDb;
  const org = yield* CurrentOrg;
  const authIndexOf = yield* currentAuthIndexer;
  const models = yield* query("unpriced", () => unpricedModels(db, org, filter, authIndexOf));

  return jsonReply(200, { models });
});

/** `GET /series`: per key × UTC hour/day bucket requests, failures and total tokens (v2 `acct_total_tokens`). */
const usageSeries = Effect.gen(function* () {
  const params = yield* queryParams;
  // Only the series filters: summary-only params (principal, failed) are ignored, not validated.
  const scoped = new URLSearchParams();

  for (const name of [
    "since",
    "until",
    "provider",
    "model",
    "member",
    "team",
    "auth_index",
    "auth_id",
  ]) {
    const value = params.get(name);

    if (value !== null) scoped.set(name, value);
  }

  const filter = yield* parseFilter(scoped);

  const since = filter.since;

  if (since === undefined) return yield* replyError(400, "since is required");
  const bucket = optional(params, "bucket") ?? "hour";

  // SAFETY: widening the literal tuple to string for the membership test; it is only read.
  if (!(SERIES_BUCKETS as ReadonlyArray<string>).includes(bucket)) {
    return yield* replyError(400, `bucket must be one of ${SERIES_BUCKETS.join(", ")}`);
  }

  const groupBy = optional(params, "group_by") ?? "auth";

  // SAFETY: widening the literal tuple to string for the membership test; it is only read.
  if (!(SERIES_GROUP_BY as ReadonlyArray<string>).includes(groupBy)) {
    return yield* replyError(400, `group_by must be one of ${SERIES_GROUP_BY.join(", ")}`);
  }

  // SAFETY: bucket and groupBy were checked against their literal tuples above.
  const seriesBucket = bucket as SeriesBucket;
  const until = filter.until ?? (yield* Clock.currentTimeMillis);

  if (until <= since) return yield* replyError(400, "until must be after since");
  const maxDays = MAX_SERIES_RANGE_DAYS[seriesBucket];

  if (until - since > maxDays * BUCKET_MS.day) {
    return yield* replyError(400, `range must not exceed ${maxDays} days for bucket=${bucket}`);
  }

  const db = yield* usageDb;
  const org = yield* CurrentOrg;
  const authIndexOf = yield* currentAuthIndexer;

  const series = yield* query("series", () =>
    summarizeUsageSeries(
      db,
      org,
      {
        since,
        until,
        bucket: seriesBucket,
        // SAFETY: see above.
        groupBy: groupBy as SeriesGroupBy,
        ...(filter.provider === undefined ? {} : { provider: filter.provider }),
        ...(filter.model === undefined ? {} : { model: filter.model }),
        ...(filter.authIndex === undefined ? {} : { authIndex: filter.authIndex }),
        ...(filter.liveAuthId === undefined ? {} : { liveAuthId: filter.liveAuthId }),
        ...(filter.memberIds === undefined ? {} : { memberIds: filter.memberIds }),
        ...(filter.own === undefined ? {} : { own: filter.own }),
      },
      authIndexOf,
    ),
  );

  return jsonReply(200, { bucket, group_by: groupBy, series });
});

export const usageRoutes = [
  HttpRouter.route("GET", `${BASE}/queue`, handled(usageQueue)),
  HttpRouter.route("GET", `${BASE}/records`, handled(usageRecords)),
  HttpRouter.route("GET", `${BASE}/series`, handled(usageSeries)),
  HttpRouter.route("GET", `${BASE}/summary`, handled(usageSummary)),
  HttpRouter.route("GET", `${BASE}/unpriced`, handled(usageUnpriced)),
];
