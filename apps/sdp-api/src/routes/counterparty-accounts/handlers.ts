import type {
  CounterpartyAccount,
  CounterpartyAccountResponse,
  ListCounterpartyAccountsResponse,
} from "@sdp/types";
import { z } from "zod";
import { getDb } from "@/db";
import type { CounterpartyAccountRow } from "@/db/repositories/counterparty-account.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import {
  badRequest,
  badRequestParams,
  badRequestQuery,
  internalError,
  notFound,
} from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import {
  type AppContext,
  getCounterpartiesRepository,
  getCounterpartyAccountsRepository,
} from "./context";
import {
  counterpartyAccountListParamsSchema,
  counterpartyAccountParamsSchema,
  createCounterpartyAccountSchema,
  cryptoWalletDetailsSchema,
  listCounterpartyAccountsQuerySchema,
  updateCounterpartyAccountSchema,
} from "./schemas";

function mapToCounterpartyAccount(row: CounterpartyAccountRow): CounterpartyAccount {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    counterpartyId: row.counterparty_id,
    accountKind: row.account_kind,
    label: row.label,
    details: row.details,
    providerAccountData: row.provider_account_data,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

export const createCounterpartyAccount = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyAccountListParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = createCounterpartyAccountSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  await assertCounterpartyExists(c, params.data.counterpartyId, auth.organizationId, projectId);

  const account = await getCounterpartyAccountsRepository(c).createCounterpartyAccount({
    organizationId: auth.organizationId,
    projectId,
    counterpartyId: params.data.counterpartyId,
    accountKind: parsed.data.accountKind,
    label: parsed.data.label ?? null,
    details: parsed.data.details ?? {},
    providerAccountData: parsed.data.providerAccountData ?? {},
  });

  if (!account) {
    throw internalError("Failed to create counterparty account");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "create",
    resourceType: "counterparty_account",
    resourceId: account.id,
    metadata: {
      counterpartyId: params.data.counterpartyId,
      accountKind: parsed.data.accountKind,
    },
  });

  const response: CounterpartyAccountResponse = { account: mapToCounterpartyAccount(account) };
  return created(c, response);
};

export const updateCounterpartyAccount = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyAccountParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = updateCounterpartyAccountSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const repo = getCounterpartyAccountsRepository(c);

  if (parsed.data.details !== undefined) {
    const existing = await repo.getCounterpartyAccountById({
      counterpartyAccountId: params.data.counterpartyAccountId,
      counterpartyId: params.data.counterpartyId,
      organizationId: auth.organizationId,
      projectId,
    });
    if (!existing) {
      throw notFound("Counterparty account");
    }
    if (existing.account_kind === "crypto_wallet") {
      const result = cryptoWalletDetailsSchema.safeParse(parsed.data.details);
      if (!result.success) {
        throw badRequest("Invalid crypto_wallet details", {
          errors: z.treeifyError(result.error),
        });
      }
    }
  }

  const updated = await repo.updateCounterpartyAccount({
    counterpartyAccountId: params.data.counterpartyAccountId,
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
    ...parsed.data,
  });

  if (!updated) {
    await assertCounterpartyExists(c, params.data.counterpartyId, auth.organizationId, projectId);
    throw notFound("Counterparty account");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "update",
    resourceType: "counterparty_account",
    resourceId: updated.id,
    metadata: { changedFields: Object.keys(parsed.data) },
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

  const archived = await getCounterpartyAccountsRepository(c).archiveCounterpartyAccount({
    counterpartyAccountId: params.data.counterpartyAccountId,
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!archived) {
    await assertCounterpartyExists(c, params.data.counterpartyId, auth.organizationId, projectId);
    throw notFound("Counterparty account");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "delete",
    resourceType: "counterparty_account",
    resourceId: archived.id,
  });

  return noContent(c);
};
