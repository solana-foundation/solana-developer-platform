import type { RampExternalAccountDetails } from "@sdp/payments/ramps/types";
import {
  BVNK_CUSTOMER_LINK_STAGE,
  type BvnkCounterpartyProviderCustomerLink,
  type CounterpartyProviderAccount,
  type ListCounterpartyProviderAccountsResponse,
} from "@sdp/types";
import { z } from "zod";
import type {
  BvnkCustomerProviderAccountMetadata,
  CounterpartyProviderAccountRow,
} from "@/db/repositories/counterparty-provider-account.repository";
import { bvnkCustomerProviderAccountMetadataSchema } from "@/db/repositories/counterparty-provider-account.repository";
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
 * Maps a customer-link row into the public customer-link shape, dispatching
 * per provider so BVNK's pre-customer session metadata gets its own stage
 * mapping while every other provider maps from the row columns directly.
 * The provider cases mirror RAMP_PROVIDERS, so a provider added there without
 * a case here fails the exhaustive default at compile time.
 *
 * @param row - Parent-scoped customer-link row.
 * @returns Public customer-link object.
 */
function mapCustomerLink(
  row: CounterpartyProviderAccountRow
): NonNullable<CounterpartyProviderAccount["customerLink"]> {
  switch (row.provider) {
    case "bvnk":
      return mapBvnkCustomerLink(row);
    case "moonpay":
    case "lightspark":
    case "moneygram":
    case "coinbase":
    case "mural":
    case "stripe":
      return {
        provider: row.provider,
        id: row.id,
        providerCustomerReference: row.provider_customer_reference,
        status: row.status,
        providerStatus: row.provider_status,
        createdAt: row.created_at,
      };
    default: {
      const exhaustive: never = row.provider;
      throw internalError(`Unhandled ramp provider: ${String(exhaustive)}`);
    }
  }
}

/**
 * Maps a BVNK customer-link row to its public shape. Before the v1 customer
 * exists, the reference column carries SDP's outbound externalReference alias,
 * so the stage comes from the stored agreement session (PENDING_AGREEMENT until
 * consent, PENDING_DETAILS once signed) and the reference stays null until the
 * v1 create replaces the alias. A claimed row whose session is not yet minted
 * (crash or concurrent window) reads as PENDING_AGREEMENT with no agreements.
 * The residence country and session are kept on the row through the create,
 * so they stay visible afterwards.
 *
 * @param row - Parent-scoped BVNK customer-link row.
 * @returns Public BVNK customer-link object.
 */
function mapBvnkCustomerLink(
  row: CounterpartyProviderAccountRow
): BvnkCounterpartyProviderCustomerLink {
  const metadata = bvnkCustomerProviderAccountMetadataSchema.parse(row.metadata);
  const residenceCountryCode = metadata.residenceCountryCode;
  if (residenceCountryCode === undefined) {
    throw internalError("BVNK customer-link metadata is missing residence country.");
  }
  const session = metadata.session;
  if (metadata.status !== undefined && session === undefined) {
    throw internalError("BVNK customer-link metadata is missing session state.");
  }
  return {
    provider: "bvnk",
    id: row.id,
    providerCustomerReference:
      metadata.status === undefined ? null : row.provider_customer_reference,
    status: row.status,
    providerStatus: bvnkCustomerLinkProviderStatus(metadata),
    createdAt: row.created_at,
    residenceCountryCode,
    agreements:
      session === undefined
        ? []
        : session.agreements.map((agreement) => ({
            name: agreement.name,
            displayName: agreement.displayName,
            url: agreement.url,
            privacyPolicyUrl: agreement.privacyPolicyUrl,
            signedAt: session.signedAt === undefined ? null : session.signedAt,
          })),
  };
}

/**
 * Derives the public provider status of a BVNK customer link: the v1 customer
 * status once the customer exists, otherwise the pre-customer stage.
 *
 * @param metadata - Parsed BVNK customer-link metadata.
 * @returns The BVNK customer status or the pre-customer stage label.
 */
function bvnkCustomerLinkProviderStatus(metadata: BvnkCustomerProviderAccountMetadata): string {
  if (metadata.status !== undefined) {
    return metadata.status;
  }
  if (metadata.session === undefined || metadata.session.signedAt === undefined) {
    return BVNK_CUSTOMER_LINK_STAGE.pendingAgreement;
  }
  return BVNK_CUSTOMER_LINK_STAGE.pendingDetails;
}
