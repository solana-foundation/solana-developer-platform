import type { RampExternalAccountDetails } from "@sdp/payments/ramps/types";
import type {
  BvnkProviderAccountLiveState,
  BvnkSettlementWalletLiveState,
  CounterpartyProviderAccount,
  CounterpartyProviderCustomerLink,
  ListCounterpartyProviderAccountsResponse,
} from "@sdp/types";
import { z } from "zod";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { providerCustomerReferenceSchema } from "@/db/repositories/counterparty-provider-account.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequestParams, badRequestQuery, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getPaymentsRepository, rampRuntime } from "@/routes/payments/context";
import {
  enrichBvnkVirtualFundingWalletLive,
  enrichBvnkVirtualSettlementWalletLive,
  enrichCounterpartyProviderAccounts,
} from "@/services/payments/provider-account-enrichment";
import type { AppContext } from "../counterparties/context";
import { getCounterpartiesRepository } from "../counterparties/context";
import { getCounterpartyProviderAccountsRepository } from "./context";
import {
  counterpartyProviderAccountParamsSchema,
  listCounterpartyProviderAccountsQuerySchema,
} from "./schemas";

/**
 * Lists parent-scoped provider accounts with just-in-time provider enrichment.
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

  const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!counterparty) {
    throw notFound("Counterparty");
  }

  const rows = await getCounterpartyProviderAccountsRepository(c).listProviderAccounts({
    organizationId: auth.organizationId,
    projectId,
    counterpartyId: counterparty.id,
    ...query.data,
  });
  const runtime = rampRuntime(c);
  const enriched = await enrichCounterpartyProviderAccounts(
    runtime,
    rows.filter((row) => row.kind === "payout_account")
  );
  const fundingLiveByRowId = await enrichBvnkVirtualFundingWalletLive(
    runtime,
    getPaymentsRepository(c),
    rows
  );
  const settlementLiveByRowId = await enrichBvnkVirtualSettlementWalletLive(runtime, rows);

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
    const fundingRows = providerRows.filter((row) => row.kind === "virtual_funding_wallet");
    const settlementRows = providerRows.filter((row) => row.kind === "virtual_settlement_wallet");
    if (
      payoutRows.length === 0 &&
      fundingRows.length === 0 &&
      settlementRows.length === 0 &&
      customerLink !== undefined
    ) {
      accounts.push(mapCustomerLinkAccount(customerLink));
    }
    for (const row of fundingRows) {
      accounts.push(mapVirtualFundingWalletAccount(row, fundingLiveByRowId, customerLink));
    }
    for (const row of settlementRows) {
      accounts.push(mapVirtualSettlementWalletAccount(row, settlementLiveByRowId, customerLink));
    }
    for (const row of payoutRows) {
      accounts.push(mapProviderAccount(row, enriched, customerLink));
    }
  }

  const response: ListCounterpartyProviderAccountsResponse = { accounts };
  return success(c, response);
};

/**
 * Maps a customer-link row into a top-level provider-account response row.
 * Used only when the provider has no payout accounts to attach the link to,
 * so the provider customer stays visible. Carries its own customer-link
 * object so consumers read customer details from one place regardless of
 * row kind.
 *
 * @param row - Parent-scoped customer-link row.
 * @returns Public provider-account response row without corridor data.
 */
function mapCustomerLinkAccount(row: CounterpartyProviderAccountRow): CounterpartyProviderAccount {
  if (row.kind !== "customer_link") {
    throw internalError("Customer-link account mapper received a non customer-link row.");
  }
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
    customerLink: mapCustomerLink(row),
  };
}

/**
 * Maps a database row and optional JIT details into the public provider-account shape.
 *
 * @param row - Parent-scoped payout-account row.
 * @param enriched - Sanitized provider details indexed by row id.
 * @param customerLink - The provider's customer-link row for the counterparty, when one exists.
 * @returns Public provider-account response row.
 */
function mapProviderAccount(
  row: CounterpartyProviderAccountRow,
  enriched: ReadonlyMap<string, RampExternalAccountDetails>,
  customerLink: CounterpartyProviderAccountRow | undefined
): CounterpartyProviderAccount {
  const fiatCurrency = row.fiat_currency;
  const destinationCountry = row.destination_country;
  if (row.kind !== "payout_account" || fiatCurrency === null || destinationCountry === null) {
    throw internalError("External provider-account row is missing corridor data.");
  }

  const detail = enriched.get(row.id);
  const result: CounterpartyProviderAccount = {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    fiatCurrency,
    destinationCountry,
    paymentRail: row.payment_rail,
    status: row.status,
    providerStatus: row.provider_status,
    createdAt: row.created_at,
  };

  if (detail !== undefined) {
    result.providerStatus = detail.providerStatus;
    if (detail.bankName !== undefined) {
      result.bankName = detail.bankName;
    }
    if (detail.accountNumberLast4 !== undefined) {
      result.accountNumberLast4 = detail.accountNumberLast4;
    }
    result.paymentRails = detail.paymentRails;
  }

  if (customerLink !== undefined) {
    result.customerLink = mapCustomerLink(customerLink);
  }

  return result;
}

/**
 * Maps a virtual funding wallet row into the public provider-account shape,
 * attaching the request-time live state (balance, payment instruments, active
 * rule) when the row was enriched. Funding wallets carry the wallet's fiat
 * currency and no destination country.
 *
 * @param row - Parent-scoped virtual funding wallet row.
 * @param live - Just-in-time live state indexed by row id.
 * @param customerLink - The provider's customer-link row for the counterparty, when one exists.
 * @returns Public provider-account response row.
 */
function mapVirtualFundingWalletAccount(
  row: CounterpartyProviderAccountRow,
  live: ReadonlyMap<string, BvnkProviderAccountLiveState>,
  customerLink: CounterpartyProviderAccountRow | undefined
): CounterpartyProviderAccount {
  const fiatCurrency = row.fiat_currency;
  if (row.kind !== "virtual_funding_wallet" || fiatCurrency === null) {
    throw internalError("Virtual funding-wallet row is missing its fiat currency.");
  }
  const result: CounterpartyProviderAccount = {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    fiatCurrency,
    destinationCountry: row.destination_country,
    paymentRail: row.payment_rail,
    status: row.status,
    providerStatus: row.provider_status,
    createdAt: row.created_at,
  };
  const rowLive = live.get(row.id);
  if (rowLive !== undefined) {
    result.live = rowLive;
  }
  if (customerLink !== undefined) {
    result.customerLink = mapCustomerLink(customerLink);
  }
  return result;
}

/**
 * Maps a virtual settlement wallet row into the public provider-account
 * shape, attaching the request-time live state (balance, payment instruments)
 * when the row was enriched. Settlement wallets carry no payment rule, so the
 * live object has no activeRule; they carry no corridor data either, so null
 * currency and country are valid here.
 *
 * @param row - Parent-scoped virtual settlement wallet row.
 * @param live - Just-in-time live state indexed by row id.
 * @param customerLink - The provider's customer-link row for the counterparty, when one exists.
 * @returns Public provider-account response row.
 */
function mapVirtualSettlementWalletAccount(
  row: CounterpartyProviderAccountRow,
  live: ReadonlyMap<string, BvnkSettlementWalletLiveState>,
  customerLink: CounterpartyProviderAccountRow | undefined
): CounterpartyProviderAccount {
  const fiatCurrency = row.fiat_currency;
  if (row.kind !== "virtual_settlement_wallet" || fiatCurrency === null) {
    throw internalError("Virtual settlement-wallet row is missing its fiat currency.");
  }
  const result: CounterpartyProviderAccount = {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    fiatCurrency,
    destinationCountry: row.destination_country,
    paymentRail: row.payment_rail,
    status: row.status,
    providerStatus: row.provider_status,
    createdAt: row.created_at,
  };
  const rowLive = live.get(row.id);
  if (rowLive !== undefined) {
    result.live = rowLive;
  }
  if (customerLink !== undefined) {
    result.customerLink = mapCustomerLink(customerLink);
  }
  return result;
}

/**
 * Maps a customer-link row into the public customer-link shape: every
 * provider stores the same identity link, so the mapping is provider-agnostic.
 *
 * @param row - Parent-scoped customer-link row.
 * @returns Public customer-link object.
 */
function mapCustomerLink(
  row: CounterpartyProviderAccountRow
): NonNullable<CounterpartyProviderAccount["customerLink"]> {
  return {
    kind: "customer_link",
    provider: row.provider,
    providerCustomerReference: providerCustomerReferenceSchema.parse(
      row.provider_customer_reference
    ),
  } satisfies CounterpartyProviderCustomerLink;
}
