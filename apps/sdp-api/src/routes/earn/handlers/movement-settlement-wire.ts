import { earnProviderDepositSettlement, earnProviderWithdrawalSettlement } from "@sdp/types";
import type { EarnMovementRow } from "@/db/repositories/earn-movements.repository";

/**
 * The wire's honest status/settled-at pair for a movement row.
 *
 * The reconciliation sweep stamps a provider-order row `finalized` the moment
 * its chain leg becomes irreversible — durable finalization evidence that
 * takes the row out of the sweep queue (a fork can no longer drop it). That
 * evidence lives in the LEDGER; the public contract defines `finalized` as
 * terminal settlement, and for a provider order the provider has not yet
 * reported completion: the shares (or redemption payout) arrive after the NAV
 * strike, outside the transaction. Reporting `finalized`/`settledAt` here
 * would show clients an apparently completed movement while the payout is
 * still awaiting provider settlement.
 *
 * So the wire translates: a provider-order row at `finalized` reads as
 * `confirmed` — the strongest honest non-terminal fact, the same mapping the
 * legacy deposit DTO has always used for `finalized` — with `settledAt`
 * withheld. Atomic rows (and every non-finalized row) pass through verbatim.
 * Unknown providers fail closed and are treated as provider-order: a finality
 * observation for a provider whose settlement semantics are unmeasurable must
 * not read as a settlement claim either.
 */
export function movementStatusOnWire(row: EarnMovementRow): {
  status: EarnMovementRow["status"];
  settledAt: string | null;
} {
  if (row.execution_model !== "vault_direct" || row.status !== "finalized") {
    return { status: row.status, settledAt: row.settled_at };
  }
  const settlement =
    row.direction === "deposit"
      ? earnProviderDepositSettlement(row.provider)
      : earnProviderWithdrawalSettlement(row.provider);
  if (settlement !== "provider_order") {
    return { status: row.status, settledAt: row.settled_at };
  }
  return { status: "confirmed", settledAt: null };
}
