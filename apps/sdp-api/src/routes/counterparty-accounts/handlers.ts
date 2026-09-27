import { hashString } from "@sdp/payments/hash";
import type {
  CounterpartyAccount,
  CounterpartyAccountDetails,
  CounterpartyAccountResponse,
  ListCounterpartyAccountsResponse,
} from "@sdp/types";
import { z } from "zod";
import { getDb } from "@/db";
import type { CounterpartyAccountRow } from "@/db/repositories/counterparty-account.repository";
import { generateCounterpartyAccountId } from "@/db/repositories/counterparty-account.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import {
  badRequest,
  badRequestParams,
  badRequestQuery,
  conflict,
  internalError,
  notFound,
} from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import {
  type AppContext,
  getCounterpartiesRepository,
  getCounterpartyAccountsRepository,
} from "./context";
import {
  counterpartyAccountListParamsSchema,
  counterpartyAccountParamsSchema,
  type createCounterpartyAccountSchema,
  cryptoWalletDetailsSchema,
  listCounterpartyAccountsQuerySchema,
  type updateCounterpartyAccountSchema,
} from "./schemas";

function mapToCounterpartyAccount(row: CounterpartyAccountRow): CounterpartyAccount {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    counterpartyId: row.counterparty_id,
    accountKind: row.account_kind,
    label: row.label,
    details: cryptoWalletDetailsSchema.parse(row.details),
    providerAccountData: row.provider_account_data,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Redacted destination fingerprint for audit evidence: a SHA-256 over the
 * network/address pair. The raw address stays in the account row; the
 * immutable ledger records only the fingerprint, so a destination change is
 * attributable and comparable across versions without copying the destination
 * itself into the hash chain.
 */
async function destinationFingerprint(
  details: CounterpartyAccountDetails | undefined
): Promise<string | null> {
  const network = typeof details?.network === "string" ? details.network : null;
  const address = typeof details?.address === "string" ? details.address : null;
  if (!network || !address) {
    return null;
  }
  return hashString(`counterparty-account-destination:${network}:${address}`);
}

async function assertCounterpartyExists(
  c: AppContext,
  counterpartyId: string,
  organizationId: string,
  projectId: string
) {
  const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId,
    organizationId,
    projectId,
  });
  if (!counterparty) {
    throw notFound("Counterparty");
  }
}

export const listCounterpartyAccounts = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyAccountListParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const query = listCounterpartyAccountsQuerySchema.safeParse(c.req.query());
  if (!query.success) {
    throw badRequestQuery({ errors: z.treeifyError(query.error) });
  }

  await assertCounterpartyExists(c, params.data.counterpartyId, auth.organizationId, projectId);

  const { page, pageSize, includeArchived, accountKind } = query.data;
  const { rows, total } = await getCounterpartyAccountsRepository(
    c
  ).listCounterpartyAccountsByCounterparty({
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
    accountKind,
    includeArchived,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const response: ListCounterpartyAccountsResponse = {
    accounts: rows.map(mapToCounterpartyAccount),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};

export const getCounterpartyAccount = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyAccountParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const account = await getCounterpartyAccountsRepository(c).getCounterpartyAccountById({
    counterpartyAccountId: params.data.counterpartyAccountId,
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!account) {
    throw notFound("Counterparty account");
  }

  const response: CounterpartyAccountResponse = { account: mapToCounterpartyAccount(account) };
  return success(c, response);
};

export const createCounterpartyAccount = async (
  c: ValidatedBodyContext<typeof createCounterpartyAccountSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyAccountListParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = c.req.valid("json");

  await assertCounterpartyExists(c, params.data.counterpartyId, auth.organizationId, projectId);

  // Active accounts resolve as payout destinations, so a create that commits
  // without its audit admission would leave an unattributed destination. The
  // hash-chained ledger cannot run inside the mutation transaction, so the
  // mutation is bracketed intent/outcome instead: a refused intent aborts
  // before anything commits, and a crash between commit and outcome leaves
  // the durable intent for reconciliation — a new destination can never exist
  // without ledger attribution.
  //
  // The account id is generated up front and pinned in the intent before the
  // insert: two accounts under the same counterparty can share a destination,
  // so the destination fingerprint alone cannot tell an operator which
  // unresolved intent admitted which account.
  const accountId = generateCounterpartyAccountId();
  const auditService = new AuditService(getDb(c.env));
  const auditIntent = await auditService.beginCritical(c, {
    action: "create",
    resourceType: "counterparty_account",
    resourceId: accountId,
    metadata: {
      counterpartyId: params.data.counterpartyId,
      accountKind: body.accountKind,
      destinationFingerprint: await destinationFingerprint(body.details),
    },
  });

  let account: CounterpartyAccountRow | null;
  try {
    account = await getCounterpartyAccountsRepository(c).createCounterpartyAccount({
      id: accountId,
      organizationId: auth.organizationId,
      projectId,
      counterpartyId: params.data.counterpartyId,
      accountKind: body.accountKind,
      label: body.label ?? null,
      details: body.details ?? {},
      providerAccountData: body.providerAccountData ?? {},
    });
  } catch (error) {
    await auditService.completeCritical(c, auditIntent, {
      status: "failure",
      metadata: { error: error instanceof Error ? error.message : "Unknown error" },
    });
    throw error;
  }

  if (!account) {
    await auditService.completeCritical(c, auditIntent, {
      status: "failure",
      metadata: { error: "Create returned no counterparty account row" },
    });
    throw internalError("Failed to create counterparty account");
  }

  await auditService.completeCritical(c, auditIntent, {
    resourceId: account.id,
    metadata: { accountVersion: account.created_at },
  });

  const response: CounterpartyAccountResponse = { account: mapToCounterpartyAccount(account) };
  return created(c, response);
};

export const updateCounterpartyAccount = async (
  c: ValidatedBodyContext<typeof updateCounterpartyAccountSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyAccountParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = c.req.valid("json");

  const repo = getCounterpartyAccountsRepository(c);

  // The current row is both the validation source and the pre-mutation
  // evidence for the audit intent below. The mutation is guarded by the row's
  // version, so a concurrent PATCH/DELETE that commits after this read makes
  // the later mutation refuse instead of committing evidence about a row it
  // never saw.
  const existing = await repo.getCounterpartyAccountById({
    counterpartyAccountId: params.data.counterpartyAccountId,
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!existing) {
    await assertCounterpartyExists(c, params.data.counterpartyId, auth.organizationId, projectId);
    throw notFound("Counterparty account");
  }
  if (existing.account_kind === "crypto_wallet" && body.details !== undefined) {
    const result = cryptoWalletDetailsSchema.safeParse(body.details);
    if (!result.success) {
      throw badRequest("Invalid crypto_wallet details", {
        errors: z.treeifyError(result.error),
      });
    }
  }

  // Active accounts resolve as payout destinations, so an update that commits
  // without its audit admission would leave a durable destination change
  // without attribution. The hash-chained ledger cannot run inside the
  // mutation transaction, so the mutation is bracketed intent/outcome instead:
  // a refused intent aborts before anything commits, and a crash between
  // commit and outcome leaves the durable intent — pinning the pre-mutation
  // account version and redacted destination fingerprints — for
  // reconciliation.
  const auditService = new AuditService(getDb(c.env));
  const auditIntent = await auditService.beginCritical(c, {
    action: "update",
    resourceType: "counterparty_account",
    resourceId: existing.id,
    metadata: {
      counterpartyId: params.data.counterpartyId,
      accountKind: existing.account_kind,
      changedFields: Object.keys(body),
      accountVersion: existing.updated_at,
      previousDestinationFingerprint: await destinationFingerprint(existing.details),
      destinationFingerprint: await destinationFingerprint(body.details ?? existing.details),
    },
  });

  let updated: CounterpartyAccountRow | null;
  try {
    updated = await repo.updateCounterpartyAccount({
      counterpartyAccountId: params.data.counterpartyAccountId,
      counterpartyId: params.data.counterpartyId,
      organizationId: auth.organizationId,
      projectId,
      expectedUpdatedAt: existing.updated_at,
      ...body,
    });
  } catch (error) {
    await auditService.completeCritical(c, auditIntent, {
      status: "failure",
      metadata: { error: error instanceof Error ? error.message : "Unknown error" },
    });
    throw error;
  }

  if (!updated) {
    // The pre-read already proved the account exists and is active, so a null
    // here can only mean a concurrent mutation won the race. Refusing keeps
    // the intent's recorded destination and version truthful; the caller
    // re-reads and re-admits.
    await auditService.completeCritical(c, auditIntent, {
      status: "failure",
      metadata: { error: "Counterparty account changed concurrently" },
    });
    throw conflict("Counterparty account changed while updating; retry with the latest account");
  }

  await auditService.completeCritical(c, auditIntent, {
    metadata: { accountVersion: updated.updated_at },
  });

  const response: CounterpartyAccountResponse = { account: mapToCounterpartyAccount(updated) };
  return success(c, response);
};

export const archiveCounterpartyAccount = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyAccountParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const repo = getCounterpartyAccountsRepository(c);
  const existing = await repo.getCounterpartyAccountById({
    counterpartyAccountId: params.data.counterpartyAccountId,
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!existing) {
    await assertCounterpartyExists(c, params.data.counterpartyId, auth.organizationId, projectId);
    throw notFound("Counterparty account");
  }

  // Active accounts resolve as payout destinations, so an archive that
  // commits without its audit admission would leave an unattributed
  // destination removal. The hash-chained ledger cannot run inside the
  // mutation transaction, so the mutation is bracketed intent/outcome instead:
  // a refused intent aborts before anything commits, and a crash between
  // commit and outcome leaves the durable intent for reconciliation.
  const auditService = new AuditService(getDb(c.env));
  const auditIntent = await auditService.beginCritical(c, {
    action: "delete",
    resourceType: "counterparty_account",
    resourceId: existing.id,
    metadata: {
      counterpartyId: params.data.counterpartyId,
      accountKind: existing.account_kind,
      accountVersion: existing.updated_at,
      destinationFingerprint: await destinationFingerprint(existing.details),
    },
  });

  let archived: CounterpartyAccountRow | null;
  try {
    archived = await repo.archiveCounterpartyAccount({
      counterpartyAccountId: params.data.counterpartyAccountId,
      counterpartyId: params.data.counterpartyId,
      organizationId: auth.organizationId,
      projectId,
      expectedUpdatedAt: existing.updated_at,
    });
  } catch (error) {
    await auditService.completeCritical(c, auditIntent, {
      status: "failure",
      metadata: { error: error instanceof Error ? error.message : "Unknown error" },
    });
    throw error;
  }

  if (!archived) {
    // The pre-read already proved the account exists and is active, so a null
    // here can only mean a concurrent mutation won the race (a PATCH changing
    // the destination the intent describes, or an archive). Refusing keeps
    // the intent's recorded destination and version truthful.
    await auditService.completeCritical(c, auditIntent, {
      status: "failure",
      metadata: { error: "Counterparty account changed concurrently" },
    });
    throw conflict("Counterparty account changed while archiving; retry with the latest account");
  }

  await auditService.completeCritical(c, auditIntent, {
    metadata: { accountVersion: archived.updated_at },
  });

  return noContent(c);
};
