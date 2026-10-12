import { createHash } from "node:crypto";
import type { IdempotencyKeyMode } from "@sdp/types";
import type { Context, MiddlewareHandler, Next } from "hono";
import { routePath } from "hono/route";
import type { ContentfulStatusCode, StatusCode } from "hono/utils/http-status";
import { getDb } from "@/db";
import {
  createPostgresIdempotencyKeyRepository,
  type IdempotencyKeyRepository,
  type StoredIdempotentResponse,
} from "@/db/repositories/idempotency-keys.repository";
import { getAuth } from "@/lib/auth";
import { AppError, internalError } from "@/lib/errors";
import { canonicalJson, type JsonValue } from "@/lib/idempotency";
import { getLogger } from "@/runtime/logger";
import { describeError } from "@/runtime/money-path-events";
import type { Env } from "@/types/env";
import { hasAuthorized, validatedInput } from "./authorize";
import { parseIdempotencyKey } from "./idempotency-key";

/** Set on a response replayed from a stored one. */
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

/**
 * Marks an {@link idempotent} handler with its key mode, for route inventory
 * tests.
 */
export const IDEMPOTENCY_MARKER = Symbol.for("sdp.idempotency");

export interface IdempotencyOptions {
  key: IdempotencyKeyMode;
  /**
   * How long a claim stays locked against concurrent requests with the same
   * key. The request renews it while it runs, so this only bounds how long a
   * crashed request blocks a retry. Defaults to 60 seconds.
   */
  leaseSeconds?: number;
  /**
   * How long the request keeps renewing its lease before it is treated as hung
   * and its key is let go. Defaults to
   * {@link MAX_IDEMPOTENCY_LEASE_RENEWAL_SECONDS}.
   */
  maxLeaseRenewalSeconds?: number;
  /**
   * What a 5xx (or an unhandled error) does to the key. Required, because the
   * right answer depends on the handler:
   *
   * - `store`, as Stripe does: the 5xx is replayed, so the caller retries with
   *   a new key. For a route with no recovery point of its own.
   * - `rerun`: the key is freed so a retry with the same request runs again.
   *   Only for a route whose handler writes its own row under a unique key
   *   before it moves anything, and replays that row on a retry, because that
   *   row is what recovers the earlier attempt.
   */
  serverErrors: "store" | "rerun";
  /**
   * Rewrites the parsed JSON body before it is fingerprinted, for a route where
   * two spellings mean the same request (for example, recipients whose order
   * does not matter). Must be pure.
   */
  canonicalize?: (body: JsonValue) => JsonValue;
}

export const DEFAULT_IDEMPOTENCY_LEASE_SECONDS = 60;
/**
 * The longest a request keeps renewing its lease. Past it, renewal stops and a
 * retry can take the key over once the lease runs out: a request still running
 * after this long is hung, and holding its key would block every retry for the
 * 24 hours the key lives. Statement and signing timeouts end requests well
 * before it.
 */
export const MAX_IDEMPOTENCY_LEASE_RENEWAL_SECONDS = 15 * 60;
export const IDEMPOTENCY_KEY_RETENTION_SECONDS = 24 * 60 * 60;
/** Bodies up to this size are stored; a larger one is stored without its body. */
export const MAX_STORED_RESPONSE_BYTES = 1024 * 1024;
const COMPLETE_ATTEMPTS = 3;

/**
 * Statuses that are not stored while the request has changed nothing: it was
 * refused, so a retry with the same key runs again. Stripe saves no result for
 * validation failures or concurrent conflicts; refusals of the caller (401,
 * 403, 429) are re-evaluated on every attempt too. Once the handler has
 * written its domain row ({@link markIdempotencyCommitted}), any status is
 * stored: the request did change something, and its retry gets the same answer.
 */
const UNSTORED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 409, 429]);
/** Statuses whose responses carry no body. */
const BODYLESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);
/** Response headers a replay carries back. Everything else is per-request. */
const STORED_RESPONSE_HEADERS = ["content-type", "location"] as const;

/** SHA-256 hex over the canonical form of everything that defines the request. */
export function requestFingerprint(input: {
  operation: string;
  params: JsonValue;
  query: Record<string, string[]>;
  body: JsonValue;
}): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/**
 * The operation a key is scoped to: the method plus the matched route pattern.
 * The step must run in a route's own chain: from `use("*")` the pattern would
 * be the mount's wildcard, collapsing every endpoint under it into one scope.
 */
export function idempotencyOperation(c: Context): string {
  const pattern = routePath(c);
  if (pattern.includes("*")) {
    throw new Error(`idempotent() must be mounted on a route, not on ${pattern}`);
  }
  return `${c.req.method} ${pattern}`;
}

/**
 * The body as the route's validator left it (defaults applied, values
 * normalised), so two spellings the schema treats as one request fingerprint
 * the same. A route without a body validator falls back to the parsed JSON.
 */
async function readFingerprintBody(
  c: Context<{ Bindings: Env }>,
  canonicalize: IdempotencyOptions["canonicalize"]
): Promise<JsonValue> {
  const body = validatedInput(c).body;
  let parsed: JsonValue;
  if (body !== undefined) {
    parsed = toJsonValue(body);
  } else {
    const raw = await c.req.text();
    try {
      // An empty body reaches validateBody as `{}`, so it is the same request.
      // SAFETY: JSON.parse returns a JSON value by definition.
      parsed = raw.trim().length === 0 ? {} : (JSON.parse(raw) as JsonValue);
    } catch {
      // Tagged so it can never equal a parsed body.
      return ["unparsed", raw];
    }
  }
  return canonicalize ? canonicalize(parsed) : parsed;
}

/** A validator's output as JSON: dates as ISO strings, bigints as strings, undefined dropped. */
function toJsonValue(value: unknown): JsonValue {
  // SAFETY: JSON.parse of JSON.stringify output is a JSON value by definition.
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === "bigint" ? entry.toString() : entry
    ) ?? "null"
  ) as JsonValue;
}

function replay(c: Context<{ Bindings: Env }>, stored: StoredIdempotentResponse): Response {
  const headers = { ...stored.headers, [IDEMPOTENT_REPLAYED_HEADER]: "true" };
  if (stored.body === null) {
    // SAFETY: a status read back from a response the app itself produced.
    return c.body(null, stored.status as StatusCode, headers);
  }
  // SAFETY: as above; a stored body means the status carries content.
  return c.body(stored.body, stored.status as ContentfulStatusCode, headers);
}

/**
 * Reads at most {@link MAX_STORED_RESPONSE_BYTES} of the response from a clone,
 * cancelling the clone past the limit. Returns null for an oversized body.
 */
async function readBoundedBody(response: Response): Promise<string | null> {
  const stream = response.clone().body;
  if (stream === null) {
    return "";
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_STORED_RESPONSE_BYTES) {
      // Not awaited: cancelling one branch of a tee settles only once the
      // other branch (the response the caller reads) is done too.
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function snapshot(response: Response, operation: string): Promise<StoredIdempotentResponse> {
  const headers: Record<string, string> = {};
  for (const name of STORED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  if (BODYLESS_STATUSES.has(response.status)) {
    return { status: response.status, headers, body: null };
  }
  let body: string | null;
  try {
    body = await readBoundedBody(response);
  } catch (error) {
    getLogger().error({ operation, ...describeError(error) }, "idempotency: body unreadable");
    body = null;
  }
  if (body === null) {
    // Never free the key after an answer: a replay gives the status alone, and
    // the caller reads the resource back.
    return { status: response.status, headers: {}, body: null };
  }
  return { status: response.status, headers, body };
}

/**
 * The answer an error thrown past a composite caller's checks stands for, when
 * this step can know it: an AppError carries its own status. Any other error
 * is mapped by the app's error handler, which this step cannot see, so it
 * returns null and the key is never stored for it.
 */
function thrownResponse(error: unknown): Response | null {
  if (!(error instanceof AppError)) {
    return null;
  }
  return new Response(JSON.stringify(error.toResponse()), {
    status: error.statusCode,
    headers: { "content-type": "application/json" },
  });
}

function logOutcome(operation: string, idempotencyKey: string, outcome: string): void {
  getLogger().info(
    {
      event: "sdp_idempotency",
      operation,
      outcome,
      // A hash, so a key that embeds caller data never reaches the logs.
      key_sha256: createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16),
    },
    "idempotency outcome"
  );
}

/**
 * Renews the lease every third of its length while the request runs, so a slow
 * handler (a Solana confirmation, a slow custody provider) is never taken over
 * mid-flight, for at most `maxRenewalSeconds`. The
 * returned stop waits for a renewal already in flight, so none can land after
 * the key is released.
 */
function startLeaseRenewal(
  repository: IdempotencyKeyRepository,
  id: string,
  claimToken: string,
  leaseSeconds: number,
  maxRenewalSeconds: number,
  operation: string
): () => Promise<void> {
  // Renewals are chained, never concurrent: one finishing out of order after
  // the release could otherwise lock the key again.
  let pending: Promise<void> = Promise.resolve();
  let stopped = false;
  const startedAt = Date.now();
  const timer = setInterval(
    () => {
      pending = pending.then(async () => {
        if (stopped) return;
        if (Date.now() - startedAt >= maxRenewalSeconds * 1000) {
          // Hung: let the lease run out so a retry can take the key over. The
          // handler's own row keeps that retry from moving anything twice.
          stopped = true;
          clearInterval(timer);
          getLogger().error(
            { event: "sdp_idempotency_lease_renewal_cap", operation },
            "idempotency: request outlived the renewal cap; releasing its lease"
          );
          return;
        }
        try {
          if (!(await repository.renew(id, claimToken, leaseSeconds))) {
            getLogger().warn({ operation }, "idempotency: lease lost while running");
          }
        } catch (error) {
          getLogger().error({ operation, ...describeError(error) }, "idempotency: renewal failed");
        }
      });
    },
    (leaseSeconds * 1000) / 3
  );
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    return pending;
  };
}

/**
 * Runs one request under its Idempotency-Key (HOO-1918; contract and prior art
 * in ADR 0008). Routes use {@link idempotent}; it is exported so a composite
 * route declaration can run it between its own checks.
 *
 * Place it after validation and the route's `authorize` step, so a replay
 * passes exactly the access checks a new request does, and before admission
 * and the handler, so a replay is not admitted again as a new movement. It
 * refuses to run without an earlier `authorize` (or `authorizeNone`).
 */
export async function runIdempotency(
  c: Context<{ Bindings: Env }>,
  next: Next,
  options: IdempotencyOptions
): Promise<Response | undefined> {
  if (!hasAuthorized(c)) {
    // A replay serves a stored response without the handler, so access must be
    // checked before this step or it is never checked for a replay at all.
    throw internalError("idempotent() must run after the route's authorize step");
  }
  const idempotencyKey = parseIdempotencyKey(c);
  if (idempotencyKey === undefined) {
    if (options.key === "required") {
      throw new AppError("IDEMPOTENCY_KEY_REQUIRED");
    }
    await next();
    return undefined;
  }

  const auth = getAuth(c);
  const operation = idempotencyOperation(c);
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_IDEMPOTENCY_LEASE_SECONDS;
  const validatedParams = validatedInput(c).params;
  const fingerprint = requestFingerprint({
    operation,
    // As the route's param validator left them, like the body.
    params: toJsonValue(validatedParams),
    // Names are ordered by the canonical form; repeated values keep their order.
    query: c.req.queries(),
    body: await readFingerprintBody(c, options.canonicalize),
  });
  const id = `idk_${crypto.randomUUID()}`;
  const claimToken = crypto.randomUUID();
  const repository = createPostgresIdempotencyKeyRepository(getDb(c.env));
  const claim = await repository.claim({
    id,
    claimToken,
    organizationId: auth.organizationId,
    projectId: c.get("projectId") ?? null, // null only on routes without project context
    operation,
    idempotencyKey,
    // Another credential reusing the key is refused (422), so it never reads a
    // response produced for a narrower or wider credential.
    principal: auth.id,
    fingerprint,
    leaseSeconds,
    retentionSeconds: IDEMPOTENCY_KEY_RETENTION_SECONDS,
  });

  switch (claim.kind) {
    case "completed":
      logOutcome(operation, idempotencyKey, "replayed");
      return replay(c, claim.response);
    case "mismatch":
      logOutcome(operation, idempotencyKey, "reused");
      throw new AppError("IDEMPOTENCY_KEY_REUSED");
    case "in_flight":
      logOutcome(operation, idempotencyKey, "in_flight");
      c.header("Retry-After", String(claim.retryAfterSeconds));
      throw new AppError("IDEMPOTENCY_KEY_IN_FLIGHT");
    case "claimed":
      // The handler records it on its domain row, so a retry past the key's
      // 24 hours is matched by the same request identity.
      c.set("idempotencyFingerprint", fingerprint);
      logOutcome(operation, idempotencyKey, claim.fresh ? "claimed" : "taken_over");
      if (claim.replacedUnfinished) {
        // The key's last request expired without recording an outcome.
        getLogger().error(
          { event: "sdp_idempotency_unfinished_replaced", operation },
          "idempotency: an expired request that never finished was replaced by a new claim"
        );
      }
      break;
  }

  const freshClaim = claim.fresh;
  // The lease is renewed until the outcome is written, not just until the
  // handler returns: reading and saving a large response takes time too.
  const stopRenewal = startLeaseRenewal(
    repository,
    id,
    claimToken,
    leaseSeconds,
    options.maxLeaseRenewalSeconds ?? MAX_IDEMPOTENCY_LEASE_RENEWAL_SECONDS,
    operation
  );
  let thrown: { error: unknown } | null = null;
  try {
    try {
      await next();
    } catch (error) {
      // Inside Hono's chain a thrown error reaches here as c.res; a composite
      // caller's own checks (admission) can throw straight through.
      thrown = { error };
    }
    await settleOutcome(thrown === null ? c.res : thrownResponse(thrown.error));
  } finally {
    await stopRenewal();
  }
  if (thrown !== null) {
    throw thrown.error;
  }
  return undefined;

  async function settleOutcome(response: Response | null): Promise<void> {
    // Releasing stops renewal first, so no renewal can land after it.
    const release = async (write: () => Promise<void>) => {
      await stopRenewal();
      await settle(write, operation);
    };
    if (response === null) {
      // An error the app maps itself (a 400 from a package error, a 500): the
      // status is unknown here, so free the lease and keep the key bound to
      // its request rather than store a guess. A same-key retry runs again.
      await release(() => repository.unlock(id, claimToken));
      return;
    }
    if (UNSTORED_STATUSES.has(response.status) && c.get("idempotencyCommitted") !== true) {
      await release(() =>
        freshClaim ? repository.discard(id, claimToken) : repository.unlock(id, claimToken)
      );
    } else if (response.status >= 500 && options.serverErrors === "rerun") {
      await release(() => repository.unlock(id, claimToken));
    } else {
      // Completing clears the claim token, so a late renewal matches nothing.
      await record(repository, id, claimToken, await snapshot(response, operation), operation);
    }
  }
}

async function record(
  repository: IdempotencyKeyRepository,
  id: string,
  claimToken: string,
  stored: StoredIdempotentResponse,
  operation: string
): Promise<void> {
  for (let attempt = 1; attempt <= COMPLETE_ATTEMPTS; attempt += 1) {
    try {
      if (!(await repository.complete(id, claimToken, stored))) {
        getLogger().warn(
          { operation, status: stored.status },
          "idempotency: lease lost before completion"
        );
      }
      return;
    } catch (error) {
      if (attempt === COMPLETE_ATTEMPTS) {
        // The lease runs out and a retry runs again; only the handler's own
        // row stands between that retry and a second execution.
        getLogger().error(
          { operation, status: stored.status, ...describeError(error) },
          "idempotency: failed to record the outcome"
        );
      }
    }
  }
}

/** Releasing a key must not turn an answered request into an error. */
async function settle(write: () => Promise<unknown>, operation: string): Promise<void> {
  try {
    await write();
  } catch (error) {
    getLogger().error({ operation, ...describeError(error) }, "idempotency: failed to release");
  }
}

/**
 * The route step that applies the shared Idempotency-Key contract
 * ({@link runIdempotency}) and declares the route's key mode.
 */
export function idempotent(options: IdempotencyOptions): MiddlewareHandler<{ Bindings: Env }> {
  const middleware: MiddlewareHandler<{ Bindings: Env }> = (c, next) =>
    runIdempotency(c, next, options);
  return Object.assign(middleware, { [IDEMPOTENCY_MARKER]: options.key });
}

/** Reads the key mode an {@link idempotent} handler declares. */
export function declaredIdempotency(handler: unknown): IdempotencyKeyMode | undefined {
  return (handler as { [IDEMPOTENCY_MARKER]?: IdempotencyKeyMode } | null)?.[IDEMPOTENCY_MARKER];
}

/**
 * Marks that the handler has written its domain row under this request's key,
 * so its response is stored whatever its status: a 400 or 409 raised after the
 * row exists is the request's answer, and a same-key retry replays it instead
 * of being answered from the row with a different status. Call it right after
 * the row is committed; refusals before it stay unstored and run again.
 */
export function markIdempotencyCommitted(c: Context<{ Bindings: Env }>): void {
  c.set("idempotencyCommitted", true);
}

/**
 * The fingerprint of the request holding its Idempotency-Key, for a handler
 * to record on its domain row; undefined when the request carried no key.
 */
export function getIdempotencyFingerprint(c: Context<{ Bindings: Env }>): string | undefined {
  return c.get("idempotencyFingerprint");
}
