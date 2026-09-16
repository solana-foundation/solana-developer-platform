import type { ApiErrorBody, DashboardData, MoneyMovementResult } from "@/types";

export async function getDashboard(): Promise<DashboardData> {
  return request<DashboardData>("/api/dashboard");
}

export async function createDeposit(
  strategyId: string,
  amount: string
): Promise<MoneyMovementResult> {
  return request<MoneyMovementResult>("/api/deposits", {
    method: "POST",
    body: JSON.stringify({ strategyId, amount }),
  });
}

export async function createWithdrawal(
  positionId: string,
  shares: string
): Promise<MoneyMovementResult> {
  return request<MoneyMovementResult>("/api/withdrawals", {
    method: "POST",
    body: JSON.stringify({ positionId, shares }),
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
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
    throw new Error(
      payload?.error?.message ?? `Request failed with ${response.status}`
    );
  }
  if (!payload?.data)
    throw new Error("The demo server returned an invalid response");
  return payload.data;
}
