import type { ApiErrorBody, DashboardData, TransferResult } from "@/types";

export class ApiError extends Error {
  readonly status: number;
  /** How long the server asked us to wait before asking again. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function getDashboard(
  activeMovementIds: readonly string[] = []
): Promise<DashboardData> {
  const search = new URLSearchParams();
  for (const movementId of activeMovementIds) {
    search.append("movementId", movementId);
  }
  const query = search.toString();
  return request<DashboardData>(`/api/dashboard${query ? `?${query}` : ""}`);
}

/** Checking to savings. */
export async function createDeposit(amount: string): Promise<TransferResult> {
  return request<TransferResult>("/api/deposits", {
    method: "POST",
    body: JSON.stringify({ amount }),
  });
}

/** Savings to checking. */
export async function createWithdrawal(
  amount: string
): Promise<TransferResult> {
  return request<TransferResult>("/api/withdrawals", {
    method: "POST",
    body: JSON.stringify({ amount }),
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Resolve against the origin, not the document URL: a page opened as
  // user:pass@host keeps those credentials in its URL, and fetch refuses them.
  const response = await fetch(new URL(path, window.location.origin), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as
    | ({ data?: T } & ApiErrorBody)
    | null;

  if (!response.ok) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ApiError(
      response.status,
      payload?.error?.message ?? `Request failed with ${response.status}`,
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : undefined
    );
  }
  if (!payload?.data)
    throw new Error("The demo server returned an invalid response");
  return payload.data;
}
