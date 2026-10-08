import { readApiErrorMessage } from "./api-error";
import { parseDashboardPathname } from "./dashboard-project-path";
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
 * `fetch` for the dashboard backend from the browser: sends the Project in this
 * tab's URL as `x-project-id`, so the request acts on the Project the tab
 * renders whatever another tab has selected since (HOO-1965). Outside a
 * Project-scoped URL no header is sent and Project-scoped backend routes
 * refuse the request.
 *
 * @param path - Dashboard backend path, e.g. `/api/dashboard/payments/transfers`.
 * @param init - Standard fetch options; a caller-set `x-project-id` is overwritten.
 * @returns The raw backend response.
 */
export function dashboardRequest(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const { projectId } = parseDashboardPathname(window.location.pathname);
  if (projectId !== null) {
    headers.set(PROJECT_HEADER_NAME, projectId);
  }
  return fetch(path, { ...init, headers });
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
