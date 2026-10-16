/**
 * `SessionState` Durable Object: generic TTL + compare-and-swap key/value store for replay and continuity state.
 *
 * New in the Workers port (the Go server keeps these caches in process memory or the Home KV). One instance per
 * (store, scope, session) address, `SESSION_STATE.getByName(addressName(...))`; the Worker talks to it through
 * {@link SessionState.run} (see `client.ts`). Expired entries read as absent immediately; an alarm deletes them
 * (and the whole instance storage once nothing is left) so abandoned sessions cost nothing.
 *
 * An instance of an org other than `global` registers itself with the org's ControlPlane (`session-state/instances.ts`)
 * while it holds entries, so that deleting the org can wipe it ({@link SessionState.wipe}, ADR 0027).
 */
import { DurableObject } from "cloudflare:workers";
import { GLOBAL_ORG, orgOfScopedName } from "@commissary/core";
import { controlPlaneOf } from "../platform/org.ts";
import { StateEngine } from "./engine.ts";
import { MAX_TTL_MS, type StateOp, type StateResult } from "./protocol.ts";
import { SqliteStateTable } from "./sqlite-table.ts";

/** An op that creates an entry or moves its expiry later: the instance may hold entries for longer than it did. */
const movesExpiry = (op: StateOp): boolean =>
  op.op === "put" || op.op === "incr" || (op.op === "get" && op.extendTtlMs !== undefined);

export class SessionState extends DurableObject<Env> {
  #engine: StateEngine;
  #armedAt: number | undefined;
  /** Until when the org's ControlPlane knows this instance (epoch ms), in this object's memory only. */
  #registeredUntil = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#engine = this.#newEngine();
  }

  #newEngine(): StateEngine {
    return new StateEngine(new SqliteStateTable(this.ctx.storage.sql));
  }

  /**
   * Executes `ops` atomically and in order. `now` is the caller's clock (Effect `Clock`, so tests control it);
   * results are positional.
   */
  async run(ops: StateOp[], now: number = Date.now()): Promise<StateResult[]> {
    const results = this.ctx.storage.transactionSync(() => this.#engine.run(ops, now));

    if (ops.some((op) => op.op === "put" || op.op === "incr"))
      await this.#arm(this.#engine.nextExpiry());

    if (ops.some(movesExpiry)) await this.#register(now);

    return results;
  }

  /**
   * Deletes everything this instance holds, at once (the org it belongs to was deleted, ADR 0027): its entries, its
   * alarm and its tables.
   */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#armedAt = undefined;
    this.#registeredUntil = 0;
    // `deleteAll` drops the SQLite tables too.
    this.#engine = this.#newEngine();
  }

  /**
   * Tells the org's ControlPlane that this instance holds entries, so deleting the org finds it. At most every half of
   * the longest time an entry lives; best effort, since an instance that is missed still deletes itself when its entries
   * expire.
   */
  async #register(now: number): Promise<void> {
    const org = orgOfScopedName(this.ctx.id.name ?? "");

    if (
      org === undefined ||
      org === GLOBAL_ORG ||
      this.ctx.id.name === undefined ||
      this.#engine.nextExpiry() === undefined ||
      this.#registeredUntil - now > MAX_TTL_MS / 2
    )
      return;

    try {
      const until = now + MAX_TTL_MS;

      await controlPlaneOf(this.env, org).registerSessionInstance(this.ctx.id.name, now, until);
      this.#registeredUntil = until;
    } catch {
      // The next write tries again.
    }
  }

  /** Drops expired entries and re-arms the alarm; an empty instance deletes its storage. */
  async sweep(now: number = Date.now()): Promise<void> {
    const next = this.ctx.storage.transactionSync(() => this.#engine.sweep(now));
    this.#armedAt = undefined;

    if (next === undefined) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      // `deleteAll` drops the SQLite tables too.
      this.#engine = this.#newEngine();

      return;
    }

    await this.#arm(next);
  }

  override async alarm(): Promise<void> {
    await this.sweep(Date.now());
  }

  async #arm(next: number | undefined): Promise<void> {
    if (next === undefined || next === this.#armedAt) return;
    this.#armedAt = next;
    await this.ctx.storage.setAlarm(next);
  }
}
