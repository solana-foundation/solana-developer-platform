import type { RampExternalAccountDetails } from "@sdp/payments/ramps/types";
import type {
  CounterpartyProviderAccount,
  ListCounterpartyProviderAccountsResponse,
} from "@sdp/types";
import { z } from "zod";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequestParams, badRequestQuery, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { rampRuntime } from "@/routes/payments/context";
import { enrichCounterpartyProviderAccounts } from "@/services/payments/provider-account-enrichment";
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
  const enriched = await enrichCounterpartyProviderAccounts(
    rampRuntime(c),
    rows.filter((row) => row.kind === "payout_account")
  );

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
    if (payoutRows.length === 0 && customerLink !== undefined) {
      accounts.push(mapCustomerLinkAccount(customerLink));
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
  if (row.fiat_currency === null || row.destination_country === null) {
    throw internalError("External provider-account row is missing corridor data.");
  }

  const detail = enriched.get(row.id);
  const result: CounterpartyProviderAccount = {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    fiatCurrency: row.fiat_currency,
    destinationCountry: row.destination_country,
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
 * Maps a customer-link row into the public customer-link shape.
 *
 * @param row - Parent-scoped customer-link row.
 * @returns Public customer-link object.
 */
function mapCustomerLink(
  row: CounterpartyProviderAccountRow
): NonNullable<CounterpartyProviderAccount["customerLink"]> {
  return {
    id: row.id,
    providerCustomerReference: row.provider_customer_reference,
    status: row.status,
    providerStatus: row.provider_status,
    createdAt: row.created_at,
  };
}
