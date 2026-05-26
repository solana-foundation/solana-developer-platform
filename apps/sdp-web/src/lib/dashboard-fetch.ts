export type DashboardFetchResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface DashboardFetchOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export async function dashboardFetch<T = unknown>(
  path: string,
  options: DashboardFetchOptions = {}
): Promise<DashboardFetchResult<T>> {
  const { method = "GET", body, signal } = options;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const json = JSON.parse(text) as {
        error?: string | { message?: string };
        message?: string;
      };
      const errObj = json?.error;
      message =
        (typeof errObj === "string" ? errObj : null) ??
        (typeof errObj === "object" && errObj !== null ? errObj.message : undefined) ??
        json?.message ??
        message;
    } catch {
      // keep status-based message
    }
    return { ok: false, error: message };
  }

  try {
    const data = (text ? JSON.parse(text) : null) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Invalid response" };
  }
}
