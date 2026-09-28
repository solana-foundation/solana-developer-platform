import { decimalStringFromNumber } from "@sdp/payments/decimal";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import type { ProviderWalletBalance } from "@sdp/types";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { getLogger } from "@/runtime/logger";

type ReferencedFundingWalletRow = CounterpartyProviderAccountRow & {
  external_account_reference: string;
};

function hasWalletReference(
  row: CounterpartyProviderAccountRow
): row is ReferencedFundingWalletRow {
  return row.external_account_reference !== null;
}

/**
 * Reads the live BVNK ledger balance of every referenced funding-wallet row
 * in parallel. This is the one designed degradation for the provider-accounts
 * list: a failing wallet read maps to the typed `unavailable` state with one
 * warning and never drops the other rows, and nothing is written to the DB.
 *
 * @param runtime - Provider runtime context (env and environment mode).
 * @param rows - Parent-scoped funding-wallet rows; only referenced rows are read.
 * @returns Live balances keyed by SDP row id, one entry per referenced row.
 */
export async function readBvnkFundingWalletBalances(
  runtime: RampRuntimeContext,
  rows: readonly CounterpartyProviderAccountRow[]
): Promise<ReadonlyMap<string, ProviderWalletBalance>> {
  const referenced = rows.filter(hasWalletReference);

  const outcomes = await Promise.all(
    referenced.map(async (row) => {
      try {
        const wallet = await RAMP_PROVIDER_CLIENTS.bvnk.getLedgerWalletV2(runtime, {
          walletId: row.external_account_reference,
        });
        if (wallet.balance === undefined) {
          getLogger().warn(
            { provider_account_id: row.id, wallet_id: row.external_account_reference },
            "[bvnk] funding-wallet balance unavailable: wallet read carries no balance"
          );
          return { row, balance: { state: "unavailable" } as const };
        }
        return {
          row,
          balance: {
            state: "available" as const,
            amount: decimalStringFromNumber(wallet.balance.amount),
            currency: wallet.balance.currency,
          },
        };
      } catch (reason) {
        getLogger().warn(
          {
            provider_account_id: row.id,
            wallet_id: row.external_account_reference,
            error_message: reason instanceof Error ? reason.message : String(reason),
          },
          "[bvnk] funding-wallet balance read failed"
        );
        return { row, balance: { state: "unavailable" } as const };
      }
    })
  );

  const balances = new Map<string, ProviderWalletBalance>();
  for (const outcome of outcomes) {
    balances.set(outcome.row.id, outcome.balance);
  }
  return balances;
}
