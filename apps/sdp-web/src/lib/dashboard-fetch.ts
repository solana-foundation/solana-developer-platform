export type DashboardFetchResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; status: number | null; body: unknown };

export interface DashboardFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Headers intentionally supplied by the caller; nothing is inferred from browser state. */
  headers?: HeadersInit;
  body?: unknown;
  signal?: AbortSignal;
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
    response = await fetch(path, {
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
      const json = JSON.parse(text) as {
        error?: string | { message?: string };
        message?: string;
      };
      errorBody = json;
      const errObj = json?.error;
      message =
        (typeof errObj === "string" ? errObj : null) ??
        (typeof errObj === "object" && errObj !== null ? errObj.message : undefined) ??
        json?.message ??
        message;
    } catch {
      // keep status-based message
    }
    return { ok: false, error: message, status: response.status, body: errorBody };
  }

  try {
    const data = (text ? JSON.parse(text) : null) as T;
    return { ok: true, data, status: response.status };
  } catch {
    return { ok: false, error: "Invalid response", status: response.status, body: text };
  }
}
