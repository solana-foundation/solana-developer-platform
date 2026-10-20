import { reconcileEarnVaultMovements } from "@/services/jobs/reconcile-earn-vault-movements";
import { alwaysEnabled, defineCron } from "./define-cron";

// NOTE: `global` for now, on purpose. This sweep reads every Environment's rows and picks each
// row's cluster from the row itself (`row.environment`), which is correct, but it is not yet
// split into one registration per Environment like the other chain-touching crons. Moving it
// to `scope: "cluster"` is tracked in HOO-2148. New chain-touching crons use `scope: "cluster"`.
/**
 * Earn vault movements: rebroadcast, confirm and settle signed deposits and withdrawals. Always
 * on: durable signed intents outlive the flag that admitted them, so their outbox keeps draining
 * even when Earn is disabled during an incident (ADR 0002).
 */
export const earnVaultMovementsCron = defineCron({
  name: "reconcile-earn-vault-movements",
  schedule: "* * * * *",
  scope: "global",
  effect: "finishes",
  enabled: alwaysEnabled,
  run: reconcileEarnVaultMovements,
});
