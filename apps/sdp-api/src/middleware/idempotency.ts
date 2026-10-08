import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";
import { routePath } from "hono/route";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getDb } from "@/db";
import {
  createPostgresIdempotencyKeyRepository,
  type StoredIdempotentResponse,
} from "@/db/repositories/idempotency-keys.repository";
import { getAuth } from "@/lib/auth";
import { AppError, badRequest } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { approvedWalletOperationId } from "@/services/policy/approved-operation-replay";
import type { Env } from "@/types/env";
import { isDryRunRequest } from "./dry-run";
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";

/** Set on a response replayed from a stored one (Stripe's header name). */
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

/** Marks an {@link idempotent} handler with its key mode, for route inventory tests. */
export const IDEMPOTENCY_MARKER = Symbol.for("sdp.idempotency");

/** `required` refuses a request without a key; `accepted` honors one when sent. */
export type IdempotencyKeyMode = "required" | "accepted";

export interface IdempotencyOptions {
  key: IdempotencyKeyMode;
  /**
   * How long a claim stays locked against concurrent requests with the same
   * key. A crashed request's key is free again once its lease ends. Defaults
   * to 60 seconds; set it above the route's worst-case run time.
   */
  leaseSeconds?: number;
  /**
   * Rewrites the parsed JSON body before it is fingerprinted, for a route where
   * two spellings mean the same request (for example, recipients whose order
   * does not matter). Must be pure. A body that is not valid JSON is never
   * passed here.
   */
  canonicalize?: (body: unknown) => unknown;
}

export const DEFAULT_IDEMPOTENCY_LEASE_SECONDS = 60;
/** How long a key is remembered (Stripe keeps keys for at least 24 hours). */
export const IDEMPOTENCY_KEY_RETENTION_SECONDS = 24 * 60 * 60;
/** Larger responses are not stored; a retry runs the handler again. */
export const MAX_STORED_RESPONSE_BYTES = 1024 * 1024;

/**
 * Statuses that are never stored: the request was refused before it changed
 * anything, so a retry with the same key runs again. Stripe saves no result
 * for validation failures (400) or concurrent conflicts (409); refusals of the
 * caller (401, 403, 429) are re-evaluated on every attempt too, so a revoked
 * caller or organization that is re-entitled needs no new key.
 */
const UNSTORED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 409, 429]);

/** Response headers a replay carries back. Everything else is per-request. */
const STORED_RESPONSE_HEADERS = ["content-type", "location"] as const;

/**
 * Serializes a JSON value with object keys sorted by UTF-16 code unit and
 * `undefined` members dropped, so equal values always produce equal text
 * (the shape of RFC 8785; numbers use ECMAScript's canonical form).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}

/** SHA-256 hex over the canonical operation, path parameters and body. */
export function requestFingerprint(input: {
  operation: string;
  params: Record<string, string>;
  body: unknown;
}): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/** The operation a key is scoped to: the method plus the matched route pattern. */
export function idempotencyOperation(c: Context): string {
  return `${c.req.method} ${routePath(c)}`;
}

async function readFingerprintBody(
  c: Context<{ Bindings: Env }>,
  canonicalize: IdempotencyOptions["canonicalize"]
): Promise<unknown> {
  // Reading the text fills Hono's body cache, so validateBody reads it again.
  const raw = await c.req.text();
  if (raw.trim().length === 0) {
    return canonicalize ? canonicalize({}) : {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Validation refuses it, and a refused request is never stored.
    return { unparsedBody: raw };
  }
  return canonicalize ? canonicalize(parsed) : parsed;
}

function replay(c: Context<{ Bindings: Env }>, stored: StoredIdempotentResponse): Response {
  return c.body(stored.body, stored.status as ContentfulStatusCode, {
    ...stored.headers,
    [IDEMPOTENT_REPLAYED_HEADER]: "true",
  });
}

async function snapshot(response: Response): Promise<StoredIdempotentResponse | null> {
  const body = await response.clone().text();
  if (Buffer.byteLength(body) > MAX_STORED_RESPONSE_BYTES) {
    return null;
  }
  const headers: Record<string, string> = {};
  for (const name of STORED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) {
      headers[name] = value;
    }
  }
  return { status: response.status, headers, body };
}

/**
 * Runs one request under its Idempotency-Key (HOO-1918). Exported so a
 * composite route declaration (HOO-1955's `requireMovement`) can run it between
 * its own steps; routes use {@link idempotent}.
 *
 * Place it after authentication, project context, `requirePermissions` and
 * Allowed Operations, so a replay re-checks the caller, and before admission
 * and body validation, so a replay of a completed request is not admitted
 * again as a new movement.
 *
 * - No key: `required` answers 400 `IDEMPOTENCY_KEY_REQUIRED`; `accepted` runs
 *   the request unkeyed.
 * - A completed key with the same fingerprint replays the stored status and
 *   body with `Idempotent-Replayed: true`.
 * - A key first used for a different request answers 422
 *   `IDEMPOTENCY_KEY_REUSED`; one whose original still runs answers 409
 *   `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`.
 * - Otherwise the request claims the key and runs. A 2xx or a 4xx outside
 *   {@link UNSTORED_STATUSES} is stored for 24 hours. A refusal is not stored
 *   and frees the key. A 5xx or a thrown error is not stored either: the lease
 *   ends and the row stays bound to its fingerprint, so a retry with the same
 *   request runs again and the handler's own row recovers the earlier attempt.
 *
 * Dry runs and approved-operation executions skip all of this: neither is a
 * keyed attempt of its own.
 */
export async function runIdempotency(
  c: Context<{ Bindings: Env }>,
  next: Next,
  options: IdempotencyOptions
): Promise<Response | undefined> {
  // The approved-operation door re-sends the original request, key included,
  // to EXECUTE it; replaying the stored 202 would mean it never runs.
  if (isDryRunRequest(c) || approvedWalletOperationId(c) !== undefined) {
    await next();
    return undefined;
  }

  const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (idempotencyKey === undefined) {
    if (options.key === "required") {
      throw new AppError("IDEMPOTENCY_KEY_REQUIRED");
    }
    await next();
    return undefined;
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw badRequest(`${IDEMPOTENCY_KEY_HEADER} must be 1-255 printable ASCII characters`);
  }

  const operation = idempotencyOperation(c);
  const fingerprint = requestFingerprint({
    operation,
    params: c.req.param() as Record<string, string>,
    body: await readFingerprintBody(c, options.canonicalize),
  });
  const id = `idk_${crypto.randomUUID()}`;
  const claimToken = crypto.randomUUID();
  const repository = createPostgresIdempotencyKeyRepository(getDb(c.env));
  const claim = await repository.claim({
    id,
    claimToken,
    organizationId: getAuth(c).organizationId,
    projectId: c.get("projectId") ?? null,
    operation,
    idempotencyKey,
    fingerprint,
    leaseSeconds: options.leaseSeconds ?? DEFAULT_IDEMPOTENCY_LEASE_SECONDS,
    retentionSeconds: IDEMPOTENCY_KEY_RETENTION_SECONDS,
  });

  switch (claim.kind) {
    case "completed":
      return replay(c, claim.response);
    case "mismatch":
      throw new AppError("IDEMPOTENCY_KEY_REUSED");
    case "in_flight":
      c.header("Retry-After", String(claim.retryAfterSeconds));
      throw new AppError("IDEMPOTENCY_KEY_IN_FLIGHT");
    case "claimed":
      break;
  }

  try {
    await next();
  } catch (error) {
    await settleQuietly(() => repository.unlock(id, claimToken), operation);
    throw error;
  }

  const status = c.res.status;
  if (status >= 500) {
    await settleQuietly(() => repository.unlock(id, claimToken), operation);
    return undefined;
  }
  if (UNSTORED_STATUSES.has(status)) {
    await settleQuietly(
      () => (claim.fresh ? repository.discard(id, claimToken) : repository.unlock(id, claimToken)),
      operation
    );
    return undefined;
  }

  const stored = await snapshot(c.res);
  if (stored === null) {
    getLogger().warn({ operation, status }, "idempotency: response too large to store");
    await settleQuietly(() => repository.unlock(id, claimToken), operation);
    return undefined;
  }
  await settleQuietly(async () => {
    if (!(await repository.complete(id, claimToken, stored))) {
      // The lease ran out and another request took the key over; it records
      // its own outcome.
      getLogger().warn({ operation, status }, "idempotency: lease lost before completion");
    }
  }, operation);
  return undefined;
}

/**
 * Recording the outcome must not turn an answered request into an error. If
 * the write fails, the lease simply runs out and the next retry runs again.
 */
async function settleQuietly(write: () => Promise<unknown>, operation: string): Promise<void> {
  try {
    await write();
  } catch (error) {
    getLogger().error(
      { operation, error: error instanceof Error ? error.message : String(error) },
      "idempotency: failed to record the outcome"
    );
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
