import type { z } from "zod";
import { getAuth, requireProjectId } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import type { AuthorizeInput } from "@/middleware/authorize";
import type { counterpartyAccountParamsSchema } from "../counterparty-accounts/schemas";
import {
  type AppContext,
  getCounterpartiesRepository,
  getCounterpartyAccountsRepository,
} from "./context";
import type { counterpartyIdParamsSchema } from "./schemas";

/**
 * Access checks for counterparty routes (HOO-1918, ADR 0009): the counterparty
 * or account the path names belongs to the caller's project, whatever its
 * status, so the retry of a request that archived it is still answered.
 */

/** The counterparty the path names, in the caller's project. */
export async function authorizeCounterparty(c: AppContext, input: AuthorizeInput) {
  // SAFETY: mounted after validateParams(counterpartyIdParamsSchema) or
  // validateParams(counterpartyAccountListParamsSchema), both of which require it.
  const { counterpartyId } = input.params as z.infer<typeof counterpartyIdParamsSchema>;
  const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId,
    organizationId: getAuth(c).organizationId,
    projectId: requireProjectId(c),
    status: "any",
  });
  if (!counterparty) {
    throw notFound("Counterparty");
  }
  return counterparty;
}

/** The counterparty account the path names, under its counterparty, in the caller's project. */
export async function authorizeCounterpartyAccount(c: AppContext, input: AuthorizeInput) {
  // SAFETY: mounted after validateParams(counterpartyAccountParamsSchema), which requires both.
  const { counterpartyId, counterpartyAccountId } = input.params as z.infer<
    typeof counterpartyAccountParamsSchema
  >;
  const account = await getCounterpartyAccountsRepository(c).getCounterpartyAccountById({
    counterpartyId,
    counterpartyAccountId,
    organizationId: getAuth(c).organizationId,
    projectId: requireProjectId(c),
    status: "any",
  });
  if (!account) {
    throw notFound("Counterparty account");
  }
  return account;
}
