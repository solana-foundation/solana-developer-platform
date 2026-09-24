/**
 * Sealed (encrypted + session-bound) render scope for dashboard mutations that
 * must stay bound to the project a page was rendered with (APE-706,
 * SOLA9-424).
 *
 * The shared `sdp_selected_project_id` cookie is host-wide: a dashboard tab
 * that rendered a form under project A can submit after a sibling tab moved
 * the cookie to project B, and a BFF route that rereads the cookie would
 * persist the mutation under B. Pages therefore seal a short-lived scope
 * recording the project they rendered with, and mutating routes refuse any
 * submission whose scope is missing, tampered, expired, or bound to a project
 * other than the current cookie-derived selection.
 *
 * The payload is AES-256-GCM encrypted with a key derived from
 * CLERK_SECRET_KEY and records which Clerk session and user minted it, plus
 * an absolute expiry. Unsealing requires the same session/user and a fresh
 * timestamp — a different account on the same browser, a logged-out browser,
 * or a replayed old token all fail closed to `null`.
 */

const SEAL_VERSION = "v1";
const KEY_CONTEXT = `sdp-render-scope:${SEAL_VERSION}`;

/**
 * Lifetime of a render scope. Long enough to cover filling a form in a
 * resting tab, short enough to bound token reuse; a page re-render (project
 * switch, `router.refresh()`) mints a fresh one.
 */
export const RENDER_SCOPE_TTL_SECONDS = 1800;

export interface RenderScopeClaims {
  sessionId: string;
  userId: string;
}

export interface SealedRenderScope {
  projectId: string;
}

interface SealedScopePayload {
  scope: SealedRenderScope;
  sid: string;
  uid: string;
  /** Absolute expiry, epoch milliseconds. Enforced server-side on unseal. */
  exp: number;
}

export type RenderScopeVerification =
  | { ok: true; projectId: string }
  | {
      ok: false;
      reason: "missing" | "invalid" | "unauthenticated" | "project_mismatch";
    };

async function deriveScopeKey(secret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`${KEY_CONTEXT}:${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function getScopeSecret(): string | null {
  const secret = process.env.CLERK_SECRET_KEY;
  return secret && secret.length > 0 ? secret : null;
}

/**
 * Seal a render scope for the given session. Returns null (never an unsigned
 * fallback) when no sealing secret is configured: a scope that cannot be
 * sealed would silently disable the binding the mutating routes enforce.
 */
export async function sealRenderScope(
  scope: SealedRenderScope,
  claims: RenderScopeClaims,
  ttlSeconds: number,
  now: number = Date.now()
): Promise<string | null> {
  const secret = getScopeSecret();
  if (!secret) {
    return null;
  }

  const key = await deriveScopeKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload: SealedScopePayload = {
    scope,
    sid: claims.sessionId,
    uid: claims.userId,
    exp: now + ttlSeconds * 1000,
  };
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload))
  );

  return [
    SEAL_VERSION,
    Buffer.from(iv).toString("base64url"),
    Buffer.from(ciphertext).toString("base64url"),
  ].join(".");
}

/**
 * Unseal a render scope for the current session. Returns null on any
 * failure: malformed value, wrong key, tampering, session or user mismatch,
 * or expiry.
 */
export async function unsealRenderScope(
  sealed: string,
  claims: RenderScopeClaims,
  now: number = Date.now()
): Promise<SealedRenderScope | null> {
  const secret = getScopeSecret();
  if (!secret) {
    return null;
  }

  const [version, ivPart, cipherPart, ...rest] = sealed.split(".");
  if (version !== SEAL_VERSION || !ivPart || !cipherPart || rest.length > 0) {
    return null;
  }

  try {
    const key = await deriveScopeKey(secret);
    const iv = Buffer.from(ivPart, "base64url");
    const ciphertext = Buffer.from(cipherPart, "base64url");
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as SealedScopePayload;

    if (payload.sid !== claims.sessionId || payload.uid !== claims.userId) {
      return null;
    }
    if (typeof payload.exp !== "number" || payload.exp <= now) {
      return null;
    }
    if (
      !payload.scope ||
      typeof payload.scope.projectId !== "string" ||
      payload.scope.projectId.length === 0
    ) {
      return null;
    }

    return payload.scope;
  } catch {
    return null;
  }
}

/**
 * Verify a render scope against the project the calling route resolved for
 * the current request. Every mismatch fails closed with a distinct reason so
 * the route can log and answer precisely: an unauthenticated caller is 401,
 * a missing/expired/tampered/wrong-session scope means the page is stale,
 * and a project mismatch means the shared selection moved after render.
 */
export async function verifyRenderScope(
  sealed: string | null | undefined,
  claims: { sessionId: string | null; userId: string | null },
  expectedProjectId: string,
  now: number = Date.now()
): Promise<RenderScopeVerification> {
  if (!claims.sessionId || !claims.userId) {
    return { ok: false, reason: "unauthenticated" };
  }
  if (typeof sealed !== "string" || sealed.length === 0) {
    return { ok: false, reason: "missing" };
  }

  const scope = await unsealRenderScope(
    sealed,
    { sessionId: claims.sessionId, userId: claims.userId },
    now
  );
  if (!scope) {
    return { ok: false, reason: "invalid" };
  }
  if (scope.projectId !== expectedProjectId) {
    return { ok: false, reason: "project_mismatch" };
  }
  return { ok: true, projectId: scope.projectId };
}
