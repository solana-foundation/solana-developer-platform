"use client";

import { type EarnProviderAction, earnProviderActionSchema } from "@sdp/types/earn-provider-orders";
import { z } from "zod";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";

const responseSchema = z.object({ data: z.object({ action: earnProviderActionSchema }) });
export async function createEarnProviderAction(
  kind: "preparations" | "cancellations",
  body: { strategyId: string; custodyWalletId: string } | { movementId: string },
  key: string
): Promise<EarnProviderAction> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/markets/earn/provider-actions/${kind}`,
    { method: "POST", body, headers: { [IDEMPOTENCY_KEY_HEADER]: key } }
  );
  if (!result.ok) throw new Error(result.error);
  return responseSchema.parse(result.data).data.action;
}
export async function fetchEarnProviderAction(id: string): Promise<EarnProviderAction> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/markets/earn/provider-actions/${encodeURIComponent(id)}`
  );
  if (!result.ok) throw new Error(result.error);
  return responseSchema.parse(result.data).data.action;
}

/** A deterministic child key keeps uncertain setup retries attached to the deposit intent. */
export class EarnVaultPreparationFailedError extends Error {}

export async function prepareEarnVaultAccount(
  body: { strategyId: string; custodyWalletId: string },
  depositKey: string,
  signal: AbortSignal
): Promise<void> {
  let action = await createEarnProviderAction("preparations", body, `${depositKey}:prepare`);
  const deadline = Date.now() + 180_000;
  while (action.status !== "finalized" && action.status !== "not_required") {
    if (signal.aborted)
      throw new Error("Account setup continues in the background. Reopen the deposit to continue.");
    if (action.status === "failed")
      throw new Error(
        action.error ?? "Account setup failed. Check the transaction before retrying."
      );
    if (Date.now() > deadline)
      throw new Error(
        "Account setup is still pending. Retry this deposit to check the same setup transaction."
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    action = await fetchEarnProviderAction(action.actionId);
  }
}
