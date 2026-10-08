import { readApiErrorMessage } from "./api-error";
import { parseDashboardPathname } from "./dashboard-project-path";
import { IDEMPOTENCY_KEY_HEADER } from "./idempotency";
import { createIdempotencyKeyStore } from "./idempotency-key-store";
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
 * which takes an Idempotency-Key on every POST and PATCH (HOO-1918).
 */
const STABLE_MUTATION_PREFIXES = [
  "/api/dashboard/payments/",
  "/api/dashboard/counterparty",
  "/api/dashboard/compliance/",
  "/api/dashboard/approval-requests/",
] as const;

const KEYED_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const mutationKeys = createIdempotencyKeyStore("sdp:dashboard:mutation:idempotency:v1");
const inFlightMutations = new Map<string, Promise<Response>>();

/**
 * A definitive answer retires the key: success, or a refusal other than a
 * conflict (409, which includes "the original is still running") or a rate
 * limit. A 5xx or a network error keeps it, so the retry the user makes is
 * the same request to the server and cannot run twice.
 */
function retiresKey(status: number): boolean {
  return status < 500 && status !== 409 && status !== 429;
}

function sendWithProject(path: string, init: RequestInit, headers: Headers): Promise<Response> {
  const { projectId } = parseDashboardPathname(window.location.pathname);
  if (projectId !== null) {
    headers.set(PROJECT_HEADER_NAME, projectId);
  }
  return fetch(path, { ...init, headers });
}

/**
 * Sends a `stable` mutation under one Idempotency-Key per user action: the
 * key is minted for the (Project, method, path, body) the user submitted and
 * reused by every retry and double-click of that same action until the server
 * answers definitively. A second identical submit while the first is still in
 * flight joins it instead of sending again.
 */
async function sendUnderActionKey(
  path: string,
  init: RequestInit,
  headers: Headers
): Promise<Response> {
  const { projectId } = parseDashboardPathname(window.location.pathname);
  const fingerprint = JSON.stringify([projectId, init.method, path, init.body ?? ""]);
  let sent = inFlightMutations.get(fingerprint);
  if (!sent) {
    headers.set(IDEMPOTENCY_KEY_HEADER, mutationKeys.claim(fingerprint));
    sent = sendWithProject(path, init, headers).then((response) => {
      if (retiresKey(response.status)) {
        mutationKeys.release(fingerprint);
      }
      return response;
    });
    const settled = sent.finally(() => inFlightMutations.delete(fingerprint));
    inFlightMutations.set(fingerprint, sent);
    void settled.catch(() => undefined);
  }
  // Every caller gets its own copy, so each can read the body.
  return (await sent).clone();
}

function takesActionKey(path: string, init: RequestInit, headers: Headers): boolean {
  const method = (init.method ?? "GET").toUpperCase();
  return (
    KEYED_METHODS.has(method) &&
    !headers.has(IDEMPOTENCY_KEY_HEADER) &&
    (init.body === undefined || init.body === null || typeof init.body === "string") &&
    STABLE_MUTATION_PREFIXES.some((prefix) => path.startsWith(prefix))
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
