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
  const enriched = await enrichCounterpartyProviderAccounts(rampRuntime(c), rows);

  const response: ListCounterpartyProviderAccountsResponse = {
    accounts: rows.map((row) => mapProviderAccount(row, enriched)),
  };
  return success(c, response);
};

/**
 * Maps a database row and optional JIT details into the public provider-account shape.
 *
 * @param row - Parent-scoped provider-account row.
 * @param enriched - Sanitized provider details indexed by row id.
 * @returns Public provider-account response row.
 */
function mapProviderAccount(
  row: CounterpartyProviderAccountRow,
  enriched: ReadonlyMap<string, RampExternalAccountDetails>
): CounterpartyProviderAccount {
  if (row.fiat_currency === null || row.destination_country === null) {
    throw internalError("External provider-account row is missing corridor data.");
  }

  const detail = enriched.get(row.id);
  const result: CounterpartyProviderAccount = {
    id: row.id,
    provider: row.provider,
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

  return result;
}
