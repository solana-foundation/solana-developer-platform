import { reconcileEarnVaultMovements } from "@/services/jobs/reconcile-earn-vault-movements";
import { alwaysEnabled, defineCron } from "./define-cron";

/**
 * Earn vault movements: rebroadcast, confirm and settle signed deposits and withdrawals, and the
 * queued withdrawals beside them, each Environment's rows on its own cluster. Always on: durable
 * signed intents outlive the flag that admitted them, so their outbox keeps draining even when
 * Earn is disabled during an incident (ADR 0002).
 */
export const earnVaultMovementsCron = defineCron({
  name: "reconcile-earn-vault-movements",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "finishes",
  enabled: alwaysEnabled,
  run: reconcileEarnVaultMovements,
});
