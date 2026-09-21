import { earnProviderDepositSettlement, earnProviderWithdrawalSettlement } from "@sdp/types";
import type { EarnMovementRow } from "@/db/repositories/earn-movements.repository";

/**
 * The wire's honest status/settled-at pair for a movement row.
 *
 * Current reconciliation records provider-order chain finality separately and
 * leaves the movement `confirmed` until authenticated provider completion.
 * This translation remains as a compatibility boundary for rows written by an
 * earlier revision that used `finalized`/`settled_at` for the chain leg: the
 * public contract defines `finalized` as terminal economic settlement, but the
 * provider may still owe shares or a redemption payout after the NAV strike.
 *
 * For that legacy shape, a provider-order row at `finalized` reads as
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
