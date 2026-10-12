import { getAuth, requireProjectId } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import type { AuthorizeInput } from "@/middleware/authorize";
import {
  type AppContext,
  getCounterpartiesRepository,
  getCounterpartyAccountsRepository,
} from "./context";

/**
 * Access checks for counterparty routes (HOO-1918, ADR 0008): the counterparty
 * or account the path names belongs to the caller's project, whatever its
 * status, so the retry of a request that archived it is still answered.
 */

function pathParam(input: AuthorizeInput, name: string): string {
  // SAFETY: mounted after validateParams with a schema that requires `name`.
  return (input.params as Record<string, string>)[name] ?? "";
}

/** The counterparty the path names, in the caller's project. */
export async function authorizeCounterparty(c: AppContext, input: AuthorizeInput) {
  const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId: pathParam(input, "counterpartyId"),
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
  const account = await getCounterpartyAccountsRepository(c).getCounterpartyAccountById({
    counterpartyId: pathParam(input, "counterpartyId"),
    counterpartyAccountId: pathParam(input, "counterpartyAccountId"),
    organizationId: getAuth(c).organizationId,
    projectId: requireProjectId(c),
    status: "any",
  });
  if (!account) {
    throw notFound("Counterparty account");
  }
  return account;
}
