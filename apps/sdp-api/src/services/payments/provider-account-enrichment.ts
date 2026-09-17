import { providerUnavailable, SdpPaymentsError } from "@sdp/payments/errors";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { isBvnkFiatCurrency } from "@sdp/payments/ramps/providers/bvnk/currencies";
import type { BvnkLedgerWalletV2 } from "@sdp/payments/ramps/providers/bvnk/schemas";
import type {
  RampExternalAccountDetails,
  RampProvider,
  RampRuntimeContext,
} from "@sdp/payments/ramps/types";
import type { BvnkProviderAccountLiveState } from "@sdp/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { providerCustomerReferenceSchema } from "@/db/repositories/counterparty-provider-account.repository";
import type { PaymentsRepository } from "@/db/repositories/payments.repository";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { internalError, serviceUnavailable } from "@/lib/errors";
import { describeError, logEvent } from "@/runtime/money-path-events";
import { z } from "zod";

const ENRICHMENT_GROUP_CONCURRENCY = 4;

interface ProviderAccountGroup {
  counterpartyId: string;
  provider: RampProviderId;
  fiatCurrency: string;
  providerCustomerReference: string;
  rowIds: Set<string>;
}

/**
 * Fetches just-in-time external account details once per provider, currency,
 * and provider customer reference group.
 *
 * @param runtime - Provider runtime context (env and environment mode).
 * @param rows - Parent-scoped external provider-account rows.
 * @returns Sanitized provider details indexed by SDP row id.
 */
export async function enrichCounterpartyProviderAccounts(
  runtime: RampRuntimeContext,
  rows: readonly CounterpartyProviderAccountRow[]
): Promise<Map<string, RampExternalAccountDetails>> {
  const groups = [...groupProviderAccounts(rows).values()];
  const enriched = new Map<string, RampExternalAccountDetails>();

  const settled = await mapSettledWithConcurrency(
    groups,
    ENRICHMENT_GROUP_CONCURRENCY,
    async (group) => ({ group, details: await fetchGroupDetails(runtime, group) })
  );

  for (const [index, result] of settled.entries()) {
    if (result.status === "rejected") {
      const group = groups[index];
      logEvent("error", {
        event: "sdp_api_counterparty_provider_account_enrichment_failed",
        provider: group.provider,
        counterparty_id: group.counterpartyId,
        row_ids: [...group.rowIds],
        ...describeError(result.reason),
      });
      throw serviceUnavailable("Counterparty provider-account enrichment failed.");
    }
    for (const detail of result.value.details) {
      if (!result.value.group.rowIds.has(detail.platformAccountId)) {
        continue;
      }
      if (enriched.has(detail.platformAccountId)) {
        throw internalError("Provider returned duplicate external-account platform ids.");
      }
      enriched.set(detail.platformAccountId, detail);
    }
  }

  return enriched;
}

/**
 * Fetches sanitized details for one enrichment group when the provider
 * supports the capability.
 *
 * @param runtime - Provider runtime context.
 * @param group - Rows sharing one provider, currency, and customer reference.
 * @returns Provider details, or none when the provider lacks the capability.
 */
async function fetchGroupDetails(
  runtime: RampRuntimeContext,
  group: ProviderAccountGroup
): Promise<RampExternalAccountDetails[]> {
  const provider: RampProvider = RAMP_PROVIDER_CLIENTS[group.provider];
  if (provider.listExternalAccountDetails === undefined) {
    return [];
  }
  return provider.listExternalAccountDetails(runtime, {
    providerCustomerReference: group.providerCustomerReference,
    fiatCurrency: group.fiatCurrency,
  });
}

/**
 * Groups completed rows by provider, fiat currency, and customer reference so
 * rows that drifted to a new provider customer are enriched against their own
 * reference instead of failing the read.
 *
 * @param rows - External provider-account rows to group.
 * @returns Groups keyed by provider, fiat currency, and customer reference.
 */
function groupProviderAccounts(
  rows: readonly CounterpartyProviderAccountRow[]
): Map<string, ProviderAccountGroup> {
  const groups = new Map<string, ProviderAccountGroup>();

  for (const row of rows) {
    if (row.fiat_currency === null) {
      throw internalError("External provider-account row is missing fiat currency.");
    }
    if (row.external_account_reference === null) {
      continue;
    }

    const key = `${row.provider}:${row.fiat_currency}:${row.provider_customer_reference}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        counterpartyId: row.counterparty_id,
        provider: row.provider,
        fiatCurrency: row.fiat_currency,
        providerCustomerReference: providerCustomerReferenceSchema.parse(
          row.provider_customer_reference
        ),
        rowIds: new Set([row.id]),
      });
      continue;
    }
    group.rowIds.add(row.id);
  }

  return groups;
}

/** Rule fields consumed for the live active-rule shape, validated from the BVNK rule list. */
const liveBvnkOnrampRuleSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  beneficiary: z
    .object({
      currency: z.string().optional(),
      cryptoAddresses: z
        .object({
          addresses: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
});
type LiveBvnkOnrampRule = z.infer<typeof liveBvnkOnrampRuleSchema>;
type LivePaymentInstrument = Extract<
  BvnkProviderAccountLiveState,
  { state: "ok" }
>["paymentInstruments"][number];

/**
 * Enriches every BVNK virtual funding wallet row with request-time live data:
 * the ledger wallet balance, its payment instruments, and the wallet's active
 * on-ramp payment rule with its in-flight transfer. Fetched per row in
 * parallel and never persisted or cached across requests. A BVNK failure on
 * one row surfaces as the unavailable live variant for that row only; the
 * remaining rows are unaffected.
 *
 * @param runtime - Provider runtime context (env and environment mode).
 * @param payments - Tenant-scoped payments repository used to resolve rule-to-transfer links.
 * @param rows - Parent-scoped provider-account rows.
 * @returns Live data keyed by SDP row id, covering only BVNK virtual funding
 * wallets in a sandbox fiat currency with a provisioned wallet reference.
 */
export async function enrichBvnkVirtualFundingWalletLive(
  runtime: RampRuntimeContext,
  payments: PaymentsRepository,
  rows: readonly CounterpartyProviderAccountRow[]
): Promise<Map<string, BvnkProviderAccountLiveState>> {
  const eligible = rows.filter(isBvnkLiveEligibleRow);
  const settled = await Promise.all(
    eligible.map(async (row): Promise<[string, BvnkProviderAccountLiveState]> => {
      return [row.id, await fetchBvnkWalletLive(runtime, payments, row)];
    })
  );
  return new Map(settled);
}

/**
 * Restricts live enrichment to BVNK virtual funding wallets whose fiat is in
 * the sandbox fiat set and whose external wallet reference is provisioned.
 *
 * @param row - Provider-account row to test for live enrichment eligibility.
 * @returns Whether the row carries a `live` field in the response.
 */
function isBvnkLiveEligibleRow(row: CounterpartyProviderAccountRow): boolean {
  return (
    row.provider === "bvnk" &&
    row.kind === "virtual_funding_wallet" &&
    row.fiat_currency !== null &&
    isBvnkFiatCurrency(row.fiat_currency) &&
    row.external_account_reference !== null
  );
}

/**
 * Fetches and maps one funding wallet's live state. Any provider read failure,
 * including a malformed rule list or a wallet without a balance, resolves to
 * the unavailable variant instead of throwing out of the caller's loop.
 *
 * @param runtime - Provider runtime context.
 * @param payments - Tenant-scoped payments repository.
 * @param row - The funding-wallet row to enrich.
 * @returns The live ok or unavailable variant for the row.
 */
async function fetchBvnkWalletLive(
  runtime: RampRuntimeContext,
  payments: PaymentsRepository,
  row: CounterpartyProviderAccountRow
): Promise<BvnkProviderAccountLiveState> {
  try {
    const walletId = row.external_account_reference;
    if (walletId === null) {
      throw providerUnavailable("BVNK funding wallet has no external wallet reference.");
    }
    const client = RAMP_PROVIDER_CLIENTS.bvnk;
    const [wallet, rules] = await Promise.all([
      client.getLedgerWalletV2(runtime, { walletId }),
      client.listOnrampRulesByWallet(runtime, { walletId }).then((ruleList) =>
        z.array(liveBvnkOnrampRuleSchema).parse(ruleList)
      ),
    ]);
    return await mapBvnkWalletLiveOk(wallet, rules, payments, row);
  } catch (error) {
    logBvnkWalletLiveFailure(row, error);
    return {
      state: "unavailable",
      code: error instanceof SdpPaymentsError ? error.code : "PROVIDER_UNAVAILABLE",
      message: error instanceof Error ? error.message : "BVNK wallet live data is unavailable.",
    };
  }
}

/**
 * Maps a fetched ledger wallet and its rule list into the ok live variant.
 * A wallet without a balance is treated as a provider failure.
 *
 * @param wallet - The BVNK ledger wallet.
 * @param rules - Validated on-ramp rules for the wallet.
 * @param payments - Tenant-scoped payments repository.
 * @param row - The funding-wallet row being enriched.
 * @returns The ok live variant for the row.
 */
async function mapBvnkWalletLiveOk(
  wallet: BvnkLedgerWalletV2,
  rules: LiveBvnkOnrampRule[],
  payments: PaymentsRepository,
  row: CounterpartyProviderAccountRow
): Promise<BvnkProviderAccountLiveState> {
  const okLive: Extract<BvnkProviderAccountLiveState, { state: "ok" }> = {
    state: "ok",
    balance: {
      amount: wallet.balance.amount,
      currency: wallet.balance.currency,
    },
    paymentInstruments: wallet.paymentInstruments.map(mapBvnkPaymentInstrument),
  };
  const found = rules.find((rule) => rule.status === "ACTIVE");
  const activeRule = found === undefined ? null : found;
  if (activeRule === null) {
    return okLive;
  }
  const destinationAddress = activeRule.beneficiary?.cryptoAddresses?.addresses?.[0];
  if (destinationAddress === undefined) {
    throw providerUnavailable("BVNK returned an active payment rule without a destination address.");
  }
  const cryptoCurrency = activeRule.beneficiary?.currency;
  if (cryptoCurrency === undefined) {
    throw providerUnavailable("BVNK returned an active payment rule without a crypto currency.");
  }
  const activeRuleTransfer = await payments.findInFlightTransferByBvnkRuleId({
    ruleId: activeRule.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
  });
  return {
    ...okLive,
    activeRule: {
      id: activeRule.id,
      status: activeRule.status,
      destinationAddress,
      cryptoCurrency,
      transferId: activeRuleTransfer === null ? null : activeRuleTransfer.id,
    },
  };
}

/**
 * Maps a wallet payment instrument into the shared public instrument shape.
 *
 * @param instrument - The instrument as returned by the BVNK client.
 * @returns The public instrument object.
 */
function mapBvnkPaymentInstrument(
  instrument: BvnkLedgerWalletV2["paymentInstruments"][number]
): LivePaymentInstrument {
  return {
    type: instrument.type,
    accountHolderName: instrument.accountHolderName,
    accountNumber: instrument.accountNumber,
    ...(instrument.remittanceInformationPrefix !== undefined
      ? { remittanceInformationPrefix: instrument.remittanceInformationPrefix }
      : {}),
    bankDetails: {
      name: instrument.bankDetails.name,
      bic: instrument.bankDetails.bic,
      ...(instrument.bankDetails.nid?.type === undefined
        ? {}
        : {
            nid: {
              value: instrument.bankDetails.nid.value,
              type: instrument.bankDetails.nid.type,
            },
          }),
    },
  };
}

/**
 * Records one row's live enrichment failure so the unavailable arm is
 * observable in telemetry, not just in the response.
 *
 * @param row - The funding-wallet row that failed.
 * @param error - The provider read error.
 */
function logBvnkWalletLiveFailure(row: CounterpartyProviderAccountRow, error: unknown): void {
  logEvent("warn", {
    event: "sdp_api_counterparty_provider_account_live_failed",
    provider: row.provider,
    counterparty_id: row.counterparty_id,
    row_id: row.id,
    wallet_id: row.external_account_reference,
    ...describeError(error),
  });
}
