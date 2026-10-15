import {
  type CounterpartyProviderAccount,
  isRetiredRampProviderId,
  type ListCounterpartyProviderAccountsResponse,
} from "@sdp/types";
import { z } from "zod";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequestParams, badRequestQuery, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { loadRampListingAdmission } from "@/routes/payments/ramps/admission";
import type { AppContext } from "../counterparties/context";
import { getCounterpartiesRepository } from "../counterparties/context";
import { getCounterpartyProviderAccountsRepository } from "./context";
import {
  counterpartyProviderAccountParamsSchema,
  listCounterpartyProviderAccountsQuerySchema,
} from "./schemas";

/**
 * Lists parent-scoped provider accounts, including retired providers as stored.
 *
 * @param c - Authenticated request context.
 * @returns Provider-account rows in the standard success envelope.
 */
export const listCounterpartyProviderAccounts = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyProviderAccountParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams();
  }

  const query = listCounterpartyProviderAccountsQuerySchema.safeParse(c.req.query());
  if (!query.success) {
    throw badRequestQuery({ errors: z.treeifyError(query.error) });
  }

  const admits = await loadRampListingAdmission(c, query.data.provider);

  const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!counterparty) {
    throw notFound("Counterparty");
  }

  // Accounts at a provider outside the release channel, not surfaced, or not
  // entitled are neither listed nor enriched: that provider is off completely.
  // A retired provider's accounts are history, so they still list, as stored.
  const rows = (
    await getCounterpartyProviderAccountsRepository(c).listProviderAccounts({
      organizationId: auth.organizationId,
      projectId,
      counterpartyId: counterparty.id,
      ...query.data,
    })
  ).filter((row) => isRetiredRampProviderId(row.provider) || admits(row.provider));
  const rowsByProvider = new Map<
    CounterpartyProviderAccountRow["provider"],
    CounterpartyProviderAccountRow[]
  >();
  for (const row of rows) {
    const providerRows = rowsByProvider.get(row.provider);
    if (providerRows === undefined) {
      rowsByProvider.set(row.provider, [row]);
    } else {
      providerRows.push(row);
    }
  }

  const accounts: CounterpartyProviderAccount[] = [];
  for (const providerRows of rowsByProvider.values()) {
    const customerLink = providerRows.find((row) => row.kind === "customer_link");
    const payoutRows = providerRows.filter((row) => row.kind === "payout_account");
    const fundingWalletRows = providerRows.filter((row) => row.kind === "funding_wallet");
    if (payoutRows.length === 0 && fundingWalletRows.length === 0 && customerLink !== undefined) {
      accounts.push(baseProviderAccount(customerLink, customerLink));
    }
    for (const row of payoutRows) {
      accounts.push(mapPayoutAccount(row, customerLink));
    }
    for (const row of fundingWalletRows) {
      accounts.push(mapFundingWalletAccount(row, customerLink));
    }
  }

  const response: ListCounterpartyProviderAccountsResponse = { accounts };
  return success(c, response);
};

/**
 * Projects the columns every provider-account row shares into the public
 * shape, attaching the provider's customer link when one exists.
 *
 * @param row - Parent-scoped provider-account row.
 * @param customerLink - The provider's customer-link row for the counterparty, when one exists.
 * @returns Public provider-account response row without kind-specific enrichment.
 */
function baseProviderAccount(
  row: CounterpartyProviderAccountRow,
  customerLink: CounterpartyProviderAccountRow | undefined
): CounterpartyProviderAccount {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    fiatCurrency: row.fiat_currency,
    destinationCountry: row.destination_country,
    paymentRail: row.payment_rail,
    status: row.status,
    providerStatus: row.provider_status,
    createdAt: row.created_at,
    ...(customerLink === undefined ? {} : { customerLink: mapCustomerLink(customerLink) }),
  };
}

/**
 * Projects a stored payout-account row; its corridor columns must be present.
 *
 * @param row - Parent-scoped payout-account row.
 * @param customerLink - The provider's customer-link row for the counterparty, when one exists.
 * @returns Public provider-account response row.
 */
function mapPayoutAccount(
  row: CounterpartyProviderAccountRow,
  customerLink: CounterpartyProviderAccountRow | undefined
): CounterpartyProviderAccount {
  if (row.fiat_currency === null || row.destination_country === null) {
    throw internalError("External provider-account row is missing corridor data.");
  }
  return baseProviderAccount(row, customerLink);
}

/** Projects a stored funding-wallet row without provider enrichment. */
function mapFundingWalletAccount(
  row: CounterpartyProviderAccountRow,
  customerLink: CounterpartyProviderAccountRow | undefined
): CounterpartyProviderAccount {
  const result = baseProviderAccount(row, customerLink);
  if (row.external_account_reference !== null) {
    result.providerAccountReference = row.external_account_reference;
  }
  return result;
}

/** Maps a stored customer-link row for live or retired providers. */
function mapCustomerLink(
  row: CounterpartyProviderAccountRow
): NonNullable<CounterpartyProviderAccount["customerLink"]> {
  return {
    provider: row.provider,
    id: row.id,
    providerCustomerReference: row.provider_customer_reference,
    status: row.status,
    providerStatus: row.provider_status,
    createdAt: row.created_at,
  };
}
