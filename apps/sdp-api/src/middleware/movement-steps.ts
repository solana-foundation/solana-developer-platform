import type { Context, MiddlewareHandler, Next } from "hono";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import { type AuthorizeInput, getAuthorized, type RouteHandler, validatedInput } from "./authorize";
import {
  getIdempotencyRecordKey,
  IDEMPOTENT_REPLAYED_HEADER,
  idempotencyFingerprintMatches,
  markIdempotencyCommitted,
  markIdempotencyRecordMismatch,
} from "./idempotency";

/**
 * The steps between `idempotent()` and a money-moving handler (HOO-1918, ADR
 * 0009), in their fixed order:
 *
 *   authorize → idempotent → replayFromRecord → admit → handler
 *
 * Neither checks access; `authorize` did that before the key was claimed.
 */

type StepContext = Context<{ Bindings: Env }>;

/** The validated request plus what the route's `authorize` step loaded. */
export interface MovementStepInput<TAuthorized> extends AuthorizeInput {
  authorized: TAuthorized;
}

function stepInput<TAuthorized>(c: StepContext): MovementStepInput<TAuthorized> {
  return { ...validatedInput(c), authorized: getAuthorized<TAuthorized>(c) };
}

/** Marks a {@link replayFromRecord} step, for route inventory tests. */
const RECORD_REPLAY_MARKER = Symbol.for("sdp.replayFromRecord");

/** A domain row's answer to a keyed request, from {@link replayFromRecord}'s finder. */
export interface RecordAnswer {
  /**
   * The key layer's fingerprint the row recorded (`getIdempotencyFingerprint`).
   * The step compares it with this request's: another request under the same
   * key is a 422. `null` only for a row that records no fingerprint (a
   * recurring lifecycle attempt), whose finder checks the request it names.
   */
  fingerprint: string | null;
  respond: () => Response | Promise<Response>;
}

/**
 * Answers a request whose Idempotency-Key already has a domain row, from that
 * row: after a takeover of a crashed attempt (the route declares
 * `idempotent({ ..., recovery: "record" })` so that takeover is allowed), or
 * past the key's 24 hours. The finder looks the row up by the credential-bound
 * record key and returns it with its stored fingerprint; a matching fingerprint
 * is answered from the row and nothing runs again, another is 422
 * `IDEMPOTENCY_KEY_REUSED`, and null means the key has no row yet. A row's
 * answer, success or failure, is marked `Idempotent-Replayed` and stored under
 * the key.
 *
 * It works from the validated request and what `authorize` loaded only: no
 * RPC, nothing that can change after the original ran (a token account closed,
 * a counterparty archived), so a request that already ran is always answered.
 * It runs before {@link admit}, so admission never refuses a request that
 * already ran.
 */
export function replayFromRecord<TAuthorized>(
  find: (
    c: StepContext,
    input: MovementStepInput<TAuthorized>,
    recordKey: string
  ) => Promise<RecordAnswer | null>
): MiddlewareHandler<{ Bindings: Env }> {
  const middleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next: Next) => {
    // The credential-bound record key (`getIdempotencyRecordKey`), never the raw header.
    const recordKey = getIdempotencyRecordKey(c);
    if (recordKey !== undefined) {
      const answer = await find(c, stepInput<TAuthorized>(c), recordKey);
      if (answer !== null) {
        if (answer.fingerprint !== null && !idempotencyFingerprintMatches(c, answer.fingerprint)) {
          markIdempotencyRecordMismatch(c);
          throw new AppError("IDEMPOTENCY_KEY_REUSED");
        }
        // The row is the request's recorded answer, success or failure: stored
        // under the key like any answer after the row exists, and marked as a
        // replay, so a client retires the key on it.
        markIdempotencyCommitted(c);
        // Copied, so the header lands on whatever Response the finder built.
        const answered = await answer.respond();
        const replayed = new Response(answered.body, answered);
        replayed.headers.set(IDEMPOTENT_REPLAYED_HEADER, "true");
        return replayed;
      }
    }
    await next();
  };
  return Object.assign(middleware, { [RECORD_REPLAY_MARKER]: true });
}

/** Whether a route step is {@link replayFromRecord}, for route inventory tests. */
export function declaresRecordReplay(handler: RouteHandler): boolean {
  return RECORD_REPLAY_MARKER in handler;
}

/**
 * Refuses new work the route cannot take now (the organization may not start
 * movements, the custody runtime refuses the wallet, the wallet is inactive).
 * State, not access: it runs after the replay exits, so a request that already
 * ran is never refused here.
 */
export function admit<TAuthorized>(
  check: (c: StepContext, input: MovementStepInput<TAuthorized>) => Promise<void>
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next: Next) => {
    await check(c, stepInput<TAuthorized>(c));
    await next();
  };
}
