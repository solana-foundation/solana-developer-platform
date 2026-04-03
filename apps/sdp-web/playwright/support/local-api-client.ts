export interface LocalApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

function extractErrorMessage(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }

  if (body && typeof body === "object") {
    const maybeError = (body as { error?: { message?: string } }).error;
    if (typeof maybeError?.message === "string") {
      return maybeError.message;
    }

    const maybeMessage = (body as { message?: string }).message;
    if (typeof maybeMessage === "string") {
      return maybeMessage;
    }
  }

  return "Unknown API error";
}

async function parseResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? ((await response.json()) as unknown) : await response.text();

  if (!response.ok) {
    throw new Error(
      `Local API request failed (${response.status}): ${extractErrorMessage(payload)}`
    );
  }

  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }

  return payload as T;
}

export function createLocalApiClient(baseUrl: string, bearerToken: string): LocalApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${normalizedBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return parseResponse<T>(response);
  };

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path) => request("DELETE", path),
  };
}
