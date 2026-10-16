/**
 * A Durable Object composed as the split ControlPlane will be (#134 "How an area's ControlPlane part works", #148): an
 * org-wide base with an area part, an `RpcTarget` constructed once per object with the base's view (`core`), creating
 * its own tables and called by the base's one alarm. The part is reachable two ways: the cached prototype getter
 * `get dummy()` (callers write `stub.dummy.x()`) and the method `dummyPart()` (`stub.dummyPart().x()`). Test-only: the
 * test Worker exports it (test/worker.ts), the deployed one never does. test/getter-pipelining.test.ts shows which of
 * the two calls work under vitest-pool-workers before the ControlPlane relies on one.
 */
import { DurableObject, RpcTarget } from "cloudflare:workers";

/** The composed object's view a part gets (`core`): what the base holds that the part needs. */
export interface ProbeCore {
  /** The org the object belongs to, which the base stores. */
  readonly org: () => string | undefined;
  /** The part's next wake-up changed: the base sets the object's one alarm again. */
  readonly rescheduled: () => Promise<void>;
}

/** The dummy area part: its own tables, an alarm step, and the calls the tests make through the getter. */
export class DummyPart extends RpcTarget {
  readonly #sql: SqlStorage;
  readonly #core: ProbeCore;

  constructor(ctx: DurableObjectState, core: ProbeCore) {
    super();
    this.#sql = ctx.storage.sql;
    this.#core = core;
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS dummy_items (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)",
    );
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS dummy_wake_ups (at INTEGER PRIMARY KEY, ran_at INTEGER)",
    );
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS dummy_alarm_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, now INTEGER NOT NULL)",
    );
  }

  /** Answers `"reached"`: the call vitest-pool-workers refuses through the getter (test/getter-pipelining.test.ts). */
  pipelinedThroughGetter(): string {
    return "reached";
  }

  /** Stores `text`; answers how many items the part holds. */
  add(text: string): number {
    this.#sql.exec("INSERT INTO dummy_items (text) VALUES (?)", text);

    return this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM dummy_items").one().n;
  }

  /** As `add`, answered asynchronously (most ControlPlane methods return a promise). */
  async addLater(text: string): Promise<number> {
    await Promise.resolve();

    return this.add(text);
  }

  list(): string[] {
    return this.#sql
      .exec<{ text: string }>("SELECT text FROM dummy_items ORDER BY id")
      .toArray()
      .map((row) => row.text);
  }

  /** The org the base holds, read through `core`. */
  org(): string | undefined {
    return this.#core.org();
  }

  /** Asks to be woken at `at` (epoch ms). */
  async wakeAt(at: number): Promise<void> {
    this.#sql.exec("INSERT OR IGNORE INTO dummy_wake_ups (at) VALUES (?)", at);
    await this.#core.rescheduled();
  }

  /** The earliest wake-up not run yet. */
  nextWakeUp(): number | null {
    return (
      this.#sql
        .exec<{ at: number | null }>(
          "SELECT MIN(at) AS at FROM dummy_wake_ups WHERE ran_at IS NULL",
        )
        .one().at ?? null
    );
  }

  /**
   * Runs the wake-ups due at `now`; answers the next one (`null`: none). Called by the base inside the object only:
   * workerd refuses `alarm` over RPC (a reserved method name, on an `RpcTarget` too).
   */
  alarm(now: number): number | null {
    this.#sql.exec("INSERT INTO dummy_alarm_calls (now) VALUES (?)", now);
    this.#sql.exec(
      "UPDATE dummy_wake_ups SET ran_at = ? WHERE ran_at IS NULL AND at <= ?",
      now,
      now,
    );

    return this.nextWakeUp();
  }

  /** The wake-ups that ran, earliest first. */
  ran(): number[] {
    return this.#sql
      .exec<{ at: number }>("SELECT at FROM dummy_wake_ups WHERE ran_at IS NOT NULL ORDER BY at")
      .toArray()
      .map((row) => row.at);
  }

  /** How often the base called `alarm`. */
  alarmCalls(): number {
    return this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM dummy_alarm_calls").one().n;
  }

  fail(message: string): void {
    throw new RangeError(message);
  }

  async failLater(message: string): Promise<void> {
    await Promise.resolve();

    throw new Error(message);
  }
}

/** The composed object: an org-wide base with one area part behind `get dummy()`. */
export class GetterProbe extends DurableObject {
  #dummy: DummyPart | undefined;
  #partsConstructed = 0;
  /** Set by `breakStart`: the object did not start (as a ControlPlane without a usable secrets key); calls fail. */
  #startFailure: string | undefined;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS probe_org (id INTEGER PRIMARY KEY CHECK (id = 1), org TEXT NOT NULL)",
    );
  }

  /** The area part, constructed once per object instance. */
  get dummy(): DummyPart {
    if (this.#startFailure !== undefined) throw new Error(this.#startFailure);

    if (this.#dummy === undefined) {
      this.#partsConstructed += 1;
      this.#dummy = new DummyPart(this.ctx, {
        org: () =>
          this.ctx.storage.sql
            .exec<{ org: string }>("SELECT org FROM probe_org WHERE id = 1")
            .toArray()[0]?.org,
        rescheduled: () => this.#setAlarm(),
      });
    }

    return this.#dummy;
  }

  /** The area part through a method rather than a getter: the call can be pipelined (`stub.dummyPart().x()`). */
  dummyPart(): DummyPart {
    return this.dummy;
  }

  // --- the base's own methods --------------------------------------------------------------------------------------

  setOrg(org: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO probe_org (id, org) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET org = excluded.org",
      org,
    );
  }

  partsConstructed(): number {
    return this.#partsConstructed;
  }

  breakStart(reason: string): void {
    this.#startFailure = reason;
  }

  /** The one alarm: calls the parts that are due, then is set to the earliest next wake-up of any part. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const part = this.dummy;
    const due = part.nextWakeUp();

    await this.#armAt(due !== null && due <= now ? part.alarm(now) : due);
  }

  async #setAlarm(): Promise<void> {
    await this.#armAt(this.dummy.nextWakeUp());
  }

  async #armAt(next: number | null): Promise<void> {
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }
}
