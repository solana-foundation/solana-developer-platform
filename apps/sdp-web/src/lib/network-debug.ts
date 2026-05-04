export const NETWORK_DEBUG_STORAGE_KEY = "sdp.debug.network.enabled";
export const MAX_NETWORK_DEBUG_ENTRIES = 50;
const NETWORK_DEBUG_BODY_PREVIEW_LIMIT = 10_000;

export type NetworkDebugRequestState = "pending" | "success" | "error" | "aborted";

export interface NetworkDebugEntry {
  debug_request_id: string;
  method: Request["method"];
  path: string;
  query?: string;
  requestBody?: string;
  responseBody?: string;
  status?: number;
  durationMs?: number;
  startedAt: number;
  endedAt?: number;
  state: NetworkDebugRequestState;
  error?: string;
}

const NETWORK_DEBUG_STATUS_CLASS_NAMES = {
  aborted: "bg-border-extra-light text-text-medium",
  error: "bg-status-error-bg text-status-error-text",
  pending: "bg-status-warning-bg text-status-warning-text",
  success: "bg-status-success-bg text-status-success-text",
} as const;

export function isNetworkDebugAvailable(): boolean {
  return (
    process.env.NODE_ENV === "development" ||
    process.env.NEXT_PUBLIC_ENABLE_NETWORK_DEBUG === "true"
  );
}

export function getStoredNetworkDebugEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(NETWORK_DEBUG_STORAGE_KEY) === "true";
}

export function setStoredNetworkDebugEnabled(enabled: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(NETWORK_DEBUG_STORAGE_KEY, enabled ? "true" : "false");
}

export function createNetworkDebugRequestId(sequence: number): string {
  return `req_${Date.now()}_${sequence}`;
}

export function resolveNetworkDebugFetchMethod(
  input: RequestInfo | URL,
  init?: RequestInit
): Request["method"] {
  if (init?.method) {
    return init.method.toUpperCase();
  }

  if (typeof input === "object" && "method" in input && typeof input.method === "string") {
    return input.method.toUpperCase();
  }

  return "GET";
}

export function matchNetworkDebugFetch(
  input: RequestInfo | URL
): { path: string; query?: string } | null {
  let url: URL;

  try {
    if (typeof input === "string" || input instanceof URL) {
      url = new URL(input, window.location.origin);
    } else {
      url = new URL(input.url, window.location.origin);
    }
  } catch {
    return null;
  }

  if (url.origin !== window.location.origin) {
    return null;
  }

  return {
    path: url.pathname,
    query: url.search ? url.search.slice(1) : undefined,
  };
}

export function toNetworkDebugErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Request aborted.";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Request failed.";
}

export function toNetworkDebugRequestState(error: unknown): NetworkDebugRequestState {
  return error instanceof DOMException && error.name === "AbortError" ? "aborted" : "error";
}

export function getNetworkDebugStatusClassName(entry: NetworkDebugEntry): string {
  if (entry.state === "error" || (entry.status !== undefined && entry.status >= 400)) {
    return NETWORK_DEBUG_STATUS_CLASS_NAMES.error;
  }

  return NETWORK_DEBUG_STATUS_CLASS_NAMES[entry.state];
}

function truncateNetworkDebugBody(value: string): string {
  if (value.length <= NETWORK_DEBUG_BODY_PREVIEW_LIMIT) {
    return value;
  }

  return `${value.slice(0, NETWORK_DEBUG_BODY_PREVIEW_LIMIT)}\n...truncated`;
}

async function readNetworkDebugBody(body: BodyInit): Promise<string> {
  if (typeof body === "string") {
    return truncateNetworkDebugBody(body);
  }

  if (body instanceof URLSearchParams) {
    return truncateNetworkDebugBody(body.toString());
  }

  if (body instanceof FormData) {
    return truncateNetworkDebugBody(
      JSON.stringify(
        Object.fromEntries(
          Array.from(body.entries()).map(([key, value]) => [
            key,
            value instanceof File ? `[file:${value.name || "unnamed"}]` : value,
          ])
        ),
        null,
        2
      )
    );
  }

  if (body instanceof Blob) {
    return truncateNetworkDebugBody(await body.text());
  }

  if (body instanceof ArrayBuffer) {
    return `[binary:${body.byteLength} bytes]`;
  }

  if (ArrayBuffer.isView(body)) {
    return `[binary:${body.byteLength} bytes]`;
  }

  return "[stream body]";
}

export async function readNetworkDebugRequestBody(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<string | undefined> {
  try {
    if (init?.body) {
      return readNetworkDebugBody(init.body);
    }

    if (input instanceof Request && !input.bodyUsed) {
      return truncateNetworkDebugBody(await input.clone().text());
    }
  } catch {
    return "[unavailable]";
  }

  return undefined;
}

export async function readNetworkDebugResponseBody(
  response: Response
): Promise<string | undefined> {
  try {
    return truncateNetworkDebugBody(await response.clone().text());
  } catch {
    return "[unavailable]";
  }
}

export function formatNetworkDebugPayloadValue(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function formatNetworkDebugMetaSummary(entry: NetworkDebugEntry): string {
  const sep = " \u00B7 ";
  const duration = entry.durationMs === undefined ? "pending" : `${entry.durationMs}ms`;
  return `${entry.method}${sep}${duration}`;
}
