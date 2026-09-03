import type { RampExternalAccountDetails } from "@sdp/payments/ramps/types";
import type { PayoutRequirementAccount } from "@sdp/types/ramp-requirements";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { internalError } from "@/lib/errors";

/**
 * Maps parent-scoped provider-account rows and sanitized provider details into
 * payout requirements accounts.
 *
 * @param rows - Parent-scoped provider-account rows.
 * @param enriched - Sanitized provider details indexed by row id.
 * @returns Completed payout accounts for the requirements tree.
 */
export function mapPayoutRequirementAccounts(
  rows: readonly CounterpartyProviderAccountRow[],
  enriched: ReadonlyMap<string, RampExternalAccountDetails>
): PayoutRequirementAccount[] {
  const accounts: PayoutRequirementAccount[] = [];
  for (const row of rows) {
    if (row.external_account_reference === null || row.provider_status === null) {
      continue;
    }
    if (row.destination_country === null) {
      throw internalError("Lightspark external-account row is missing corridor data.");
    }

    const detail = enriched.get(row.id);
    const account: PayoutRequirementAccount = {
      id: row.id,
      destinationCountry: row.destination_country,
      paymentRail: row.payment_rail,
      status: row.provider_status,
    };
    if (detail !== undefined && detail.bankName !== undefined) {
      account.bankName = detail.bankName;
    }
    if (detail !== undefined && detail.accountNumberLast4 !== undefined) {
      account.accountNumberLast4 = detail.accountNumberLast4;
    }
    accounts.push(account);
  }
  return accounts;
}
