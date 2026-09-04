import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type {
  RampExternalAccountDetails,
  RampProvider,
  RampRuntimeContext,
} from "@sdp/payments/ramps/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { internalError, serviceUnavailable } from "@/lib/errors";
import { describeError, logEvent } from "@/runtime/money-path-events";

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
        providerCustomerReference: row.provider_customer_reference,
        rowIds: new Set([row.id]),
      });
      continue;
    }
    group.rowIds.add(row.id);
  }

  return groups;
}
