"use client";

import {
  type EarnProviderAction,
  earnProviderActionSchema,
  isTerminalEarnProviderActionStatus,
} from "@sdp/types/earn-provider-orders";
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

/**
 * Terminal provider refusal: setup failed on-chain. The deposit's idempotency
 * key is released, so a retry is a new request. The helper carries the
 * provider's own refusal as `reason` for diagnostics; UI copy comes from the
 * catalog, translated where the error is caught.
 */
export class EarnVaultPreparationFailedError extends Error {
  readonly reason: string | null;
  constructor(reason: string | null) {
    super("Vault account preparation failed");
    this.name = "EarnVaultPreparationFailedError";
    this.reason = reason;
  }
}

/**
 * Setup is still in flight or was cut short without an outcome: the deposit's
 * idempotency key stays claimed, so a retry replays the same setup attempt.
 * `messageKey` is the catalog entry the UI boundary translates.
 */
export class EarnVaultPreparationPendingError extends Error {
  readonly messageKey:
    | "DashboardEarn.deposit.vaultPreparationBackground"
    | "DashboardEarn.deposit.vaultPreparationPending";
  constructor(messageKey: EarnVaultPreparationPendingError["messageKey"]) {
    super(messageKey);
    this.name = "EarnVaultPreparationPendingError";
    this.messageKey = messageKey;
  }
}

export async function prepareEarnVaultAccount(
  body: { strategyId: string; custodyWalletId: string },
  depositKey: string,
  signal: AbortSignal
): Promise<void> {
  // A deterministic child key keeps uncertain setup retries attached to the
  // deposit intent that waits on them.
  let action = await createEarnProviderAction("preparations", body, `${depositKey}:prepare`);
  const deadline = Date.now() + 180_000;
  while (!isTerminalEarnProviderActionStatus(action.status)) {
    if (signal.aborted)
      throw new EarnVaultPreparationPendingError(
        "DashboardEarn.deposit.vaultPreparationBackground"
      );
    if (Date.now() > deadline)
      throw new EarnVaultPreparationPendingError("DashboardEarn.deposit.vaultPreparationPending");
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    action = await fetchEarnProviderAction(action.actionId);
  }
  // `failed` is terminal, so the loop above exits on it: judge the outcome
  // AFTER the loop, or a failed setup would fall through and let the deposit
  // proceed. Throwing releases the deposit's idempotency key, so the next
  // attempt can prepare again.
  if (action.status === "failed") throw new EarnVaultPreparationFailedError(action.error);
}
