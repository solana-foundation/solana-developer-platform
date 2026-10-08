import { readApiErrorMessage } from "./api-error";
import { parseDashboardPathname } from "./dashboard-project-path";
import { IDEMPOTENCY_KEY_HEADER } from "./idempotency";
import { createIdempotencyKeyStore, type IdempotencyKeyStore } from "./idempotency-key-store";
import { PROJECT_HEADER_NAME } from "./project-cookie";

export type DashboardFetchResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; status: number | null; body: unknown };

export interface DashboardFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Headers supplied by the caller; only the Project is taken from the tab's URL. */
  headers?: HeadersInit;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Dashboard backend routes that proxy a `stable` module mutation to sdp-api,
 * which takes an Idempotency-Key on every POST and PATCH (HOO-1918). Ramps
 * are not `stable` and keep their own handling.
 */
const STABLE_MUTATION_PREFIXES = [
  "/api/dashboard/payments/transfers",
  "/api/dashboard/payments/requests",
  "/api/dashboard/payments/recurring-payments",
  "/api/dashboard/payments/subscription-plans",
  "/api/dashboard/payments/subscriptions",
  "/api/dashboard/counterparty",
  "/api/dashboard/compliance/",
  "/api/dashboard/approval-requests/",
] as const;

function isStableMutationPath(path: string): boolean {
  const pathname = path.split("?", 1)[0] ?? path;
  return STABLE_MUTATION_PREFIXES.some(
    (prefix) =>
      pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
  );
}

const KEYED_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let mutationKeyStore: IdempotencyKeyStore | null = null;

/**
 * Created on first use, never at import: server routes import this module, and
 * the store is a client function that the server may not call.
 */
function mutationKeys(): IdempotencyKeyStore {
  mutationKeyStore ??= createIdempotencyKeyStore("sdp:dashboard:mutation:idempotency:v1");
  return mutationKeyStore;
}
const inFlightMutations = new Map<string, Promise<Response>>();

/**
 * Whether an answer retires the key, so the next submit is a new action.
 *
 * - A success or a refusal other than a conflict or a rate limit is definitive.
 * - A replayed answer is definitive: sdp-api stored it, so the same key would
 *   only replay it again.
 * - A first 5xx is not: on a route that re-runs after a 5xx the same key is
 *   what makes the retry safe, and on one that stores it the retry comes back
 *   as a replay, which then retires the key.
 */
function retiresKey(response: Response): boolean {
  if (response.headers.get("Idempotent-Replayed") === "true") return true;
  return response.status < 500 && response.status !== 409 && response.status !== 429;
}

function sendWithProject(path: string, init: RequestInit, headers: Headers): Promise<Response> {
  const { projectId } = parseDashboardPathname(window.location.pathname);
  if (projectId !== null) {
    headers.set(PROJECT_HEADER_NAME, projectId);
  }
  return fetch(path, { ...init, headers });
}

/** The action a submit stands for: Project, method, path and body. */
function actionMaterial(path: string, init: RequestInit): string {
  const { projectId } = parseDashboardPathname(window.location.pathname);
  return JSON.stringify([projectId, init.method, path, init.body ?? ""]);
}

/**
 * A 64-bit FNV-1a digest of the action, so request bodies (counterparty
 * details, addresses) never sit in browser storage. Synchronous on purpose:
 * an async digest would delay the send behind later requests and reorder
 * them. Not a security boundary; collisions only within one tab's few
 * pending actions matter, and 64 bits makes those negligible.
 */
function storageFingerprint(material: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(material)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function abortable(response: Promise<Response>, signal: AbortSignal | null | undefined) {
  if (!signal) return response;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    response.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Sends a `stable` mutation under one Idempotency-Key per user action: the
 * key is minted for the (Project, method, path, body) the user submitted and
 * reused by every retry and double-click of that same action until the answer
 * is definitive ({@link retiresKey}). While the outcome is unknown (a network
 * failure, a first 5xx) the key is held past its normal expiry. A second
 * identical submit while the first is in flight joins it, and one caller
 * aborting never cancels the shared request.
 */
async function sendUnderActionKey(
  path: string,
  init: RequestInit,
  headers: Headers
): Promise<Response> {
  // Joined synchronously, before any await, so a double submit can never race
  // past the check. The in-memory map may hold the raw action; storage may not.
  const material = actionMaterial(path, init);
  let sent = inFlightMutations.get(material);
  if (!sent) {
    const { signal: _callerSignal, ...shared } = init;
    const fingerprint = storageFingerprint(material);
    headers.set(IDEMPOTENCY_KEY_HEADER, mutationKeys().claim(fingerprint));
    sent = sendWithProject(path, shared, headers).then(
      (response) => {
        if (retiresKey(response)) {
          mutationKeys().release(fingerprint);
        } else {
          mutationKeys().markUncertain(fingerprint);
        }
        return response;
      },
      (error: unknown) => {
        mutationKeys().markUncertain(fingerprint);
        throw error;
      }
    );
    inFlightMutations.set(material, sent);
    void sent.finally(() => inFlightMutations.delete(material)).catch(() => undefined);
  }
  // Every caller gets its own copy, so each can read the body.
  return (await abortable(sent, init.signal)).clone();
}

function takesActionKey(path: string, init: RequestInit, headers: Headers): boolean {
  const method = (init.method ?? "GET").toUpperCase();
  return (
    KEYED_METHODS.has(method) &&
    !headers.has(IDEMPOTENCY_KEY_HEADER) &&
    (init.body === undefined || init.body === null || typeof init.body === "string") &&
    isStableMutationPath(path)
  );
}

/**
 * `fetch` for the dashboard backend from the browser: sends the Project in this
 * tab's URL as `x-project-id`, so the request acts on the Project the tab
 * renders whatever another tab has selected since (HOO-1965). Outside a
 * Project-scoped URL no header is sent and Project-scoped backend routes
 * refuse the request.
 *
 * A `stable` module mutation without a caller-chosen Idempotency-Key gets one
 * per user action (see `sendUnderActionKey`). Flows that manage their own key
 * (transfers, batches) set the header and are left alone.
 *
 * @param path - Dashboard backend path, e.g. `/api/dashboard/payments/transfers`.
 * @param init - Standard fetch options; a caller-set `x-project-id` is overwritten.
 * @returns The raw backend response.
 */
export function dashboardRequest(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (takesActionKey(path, init, headers)) {
    return sendUnderActionKey(
      path,
      { ...init, method: (init.method ?? "GET").toUpperCase() },
      headers
    );
  }
  return sendWithProject(path, init, headers);
}

export async function dashboardFetch<T = unknown>(
  path: string,
  options: DashboardFetchOptions = {}
): Promise<DashboardFetchResult<T>> {
  const { method = "GET", headers: suppliedHeaders, body, signal } = options;
  const headers = new Headers(suppliedHeaders);
  if (body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await dashboardRequest(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error",
      status: null,
      body: null,
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error",
      status: response.status,
      body: null,
    };
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let errorBody: unknown = text;
    try {
      const json: unknown = JSON.parse(text);
      errorBody = json;
      message = readApiErrorMessage(json) ?? message;
    } catch {}
    return { ok: false, error: message, status: response.status, body: errorBody };
  }

  try {
    const data = (text ? JSON.parse(text) : null) as T;
    return { ok: true, data, status: response.status };
  } catch {
    return { ok: false, error: "Invalid response", status: response.status, body: text };
  }
}
