import * as solanaRpc from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import type {
  PaymentWalletControlProfileSummary,
  PaymentWalletPolicyAuditEntry,
  PolicyDefaultAction,
  PolicyRule,
} from "@sdp/types";
import type { Address } from "@solana/kit";
import { z } from "zod";
import { type DatabaseExecutor, getDb } from "@/db";
import { asPostgresJsonArray } from "@/db/postgres-utils";
import {
  type ActiveWalletControlProfileResult,
  createPostgresPaymentsRepository,
  type WalletPolicyEvaluationAuditRow,
} from "@/db/repositories";
import {
  generateWalletControlProfileId,
  generateWalletControlProfileRevisionId,
} from "@/db/repositories/policy.repository";
import { AppError, badRequest, conflict } from "@/lib/errors";
import { success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import {
  attachTokenSymbolsToBalances,
  attachUsdValuesToBalances,
} from "@/services/helius-das.service";
import { type AppContext, getPaymentsRepository, getPolicyRepository } from "../context";
import {
  buildWalletPolicyPayload,
  DESTINATION_ALLOWLIST_POLICY_TYPE,
  mergeWalletPolicyPatch,
  PAYMENT_POLICY_VERSION,
  TRANSFER_LIMITS_POLICY_TYPE,
} from "../policy";
import { updateWalletPolicySchema } from "../schemas";
import * as tokenAccounts from "../token-accounts";
import { resolveIssuedTokenLabelsByMint } from "../token-labels";
import { resolveWalletFromParams } from "./transfers";

function mapWalletControlProfileSummary(
  active: ActiveWalletControlProfileResult
): PaymentWalletControlProfileSummary {
  return {
    id: active.profile.id,
    status: active.profile.status,
    activeRevisionId: active.profile.active_revision_id,
    revisionId: active.revision?.id ?? null,
    revisionNumber: active.revision?.revision_number ?? null,
    commitMessage: active.revision === null ? null : active.revision.commit_message,
    defaultAction: active.revision?.default_action ?? "allow",
    rules: (active.revision?.rules ?? []) as unknown as PolicyRule[],
    providerMappingStatus: "not_applicable",
    createdAt: active.profile.created_at,
    updatedAt: active.profile.updated_at,
    activatedAt: active.profile.activated_at,
  };
}

async function getWalletControlProfileSummary(
  c: AppContext,
  custodyWalletId: string
): Promise<PaymentWalletControlProfileSummary | null> {
  const active =
    await getPolicyRepository(c).getActiveWalletControlProfileByCustodyWalletId(custodyWalletId);

  return active ? mapWalletControlProfileSummary(active) : null;
}

function mapPolicyAuditEntry(row: WalletPolicyEvaluationAuditRow): PaymentWalletPolicyAuditEntry {
  return {
    walletOperationId: row.wallet_operation_id,
    policyEvaluationId: row.policy_evaluation_id,
    operationFamily: row.operation_family,
    operationType: row.operation_type,
    asset: row.asset,
    amount: row.amount,
    destination: row.destination,
    status: row.operation_status,
    decision: row.decision,
    reasonCode: row.reason_code,
    reason: row.reason,
    requiresApproval: row.requires_approval,
    approvalRequestId: row.approval_request_id,
    operationCreatedAt: row.operation_created_at,
    operationUpdatedAt: row.operation_updated_at,
    evaluatedAt: row.evaluated_at,
  };
}

async function getWalletPolicyAudit(
  c: AppContext,
  input: { organizationId: string; projectId: string | null; custodyWalletId: string }
) {
  const result = await getPolicyRepository(c).listWalletPolicyEvaluationAudits({
    organizationId: input.organizationId,
    projectId: input.projectId,
    custodyWalletId: input.custodyWalletId,
    pageSize: 10,
  });

  return {
    recentEvaluations: result.rows.map(mapPolicyAuditEntry),
  };
}

/**
 * The wallet's active control profile with its active revision content, read
 * with a row lock so the caller's merge base cannot change before it commits.
 */
interface LockedActiveWalletControlProfile {
  profile_id: string;
  revision_id: string | null;
  rules: unknown;
  default_action: PolicyDefaultAction | null;
}

/**
 * Reads the active control-profile summary on the update transaction's own
 * connection, so the response reflects exactly the state this request
 * committed — a post-commit read could mix in a concurrent update's profile.
 */
async function readWalletControlProfileSummaryInTransaction(
  db: DatabaseExecutor,
  custodyWalletId: string
): Promise<PaymentWalletControlProfileSummary | null> {
  const row = await db
    .prepare(
      `SELECT p.id AS id,
              p.status AS status,
              p.active_revision_id AS active_revision_id,
              p.created_at AS created_at,
              p.updated_at AS updated_at,
              p.activated_at AS activated_at,
              r.id AS revision_id,
              r.revision_number AS revision_number,
              r.commit_message AS commit_message,
              r.rules AS rules,
              r.default_action AS default_action
       FROM wallet_control_profiles p
       LEFT JOIN wallet_control_profile_revisions r ON r.id = p.active_revision_id
       WHERE p.custody_wallet_id = ?
         AND p.status = 'active'
       ORDER BY p.activated_at DESC NULLS LAST, p.created_at DESC
       LIMIT 1`
    )
    .bind(custodyWalletId)
    .first<{
      id: string;
      status: PaymentWalletControlProfileSummary["status"];
      active_revision_id: string | null;
      created_at: string;
      updated_at: string;
      activated_at: string | null;
      revision_id: string | null;
      revision_number: number | null;
      commit_message: string | null;
      rules: unknown;
      default_action: PolicyDefaultAction | null;
    }>();

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    status: row.status,
    activeRevisionId: row.active_revision_id,
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    commitMessage: row.revision_id === null ? null : row.commit_message,
    defaultAction: row.default_action ?? "allow",
    rules: row.revision_id ? (asPostgresJsonArray(row.rules) as unknown as PolicyRule[]) : [],
    providerMappingStatus: "not_applicable",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
  };
}

async function lockActiveWalletControlProfile(
  db: DatabaseExecutor,
  custodyWalletId: string
): Promise<LockedActiveWalletControlProfile | null> {
  return await db
    .prepare(
      `SELECT p.id AS profile_id,
              r.id AS revision_id,
              r.rules AS rules,
              r.default_action AS default_action
       FROM wallet_control_profiles p
       LEFT JOIN wallet_control_profile_revisions r ON r.id = p.active_revision_id
       WHERE p.custody_wallet_id = ?
         AND p.status = 'active'
       ORDER BY p.activated_at DESC NULLS LAST, p.created_at DESC
       LIMIT 1
       FOR UPDATE OF p`
    )
    .bind(custodyWalletId)
    .first<LockedActiveWalletControlProfile>();
}

async function activateWalletControlProfileRevisionInTransaction({
  db,
  existingProfileId,
  organizationId,
  projectId,
  custodyWalletId,
  profileName,
  rules,
  defaultAction,
  commitMessage,
  createdBy,
  activatedAt,
}: {
  db: DatabaseExecutor;
  existingProfileId: string | null;
  organizationId: string;
  projectId: string | null;
  custodyWalletId: string;
  profileName: string;
  rules: PolicyRule[];
  defaultAction: PolicyDefaultAction;
  commitMessage?: string;
  createdBy: string | null;
  activatedAt: string;
}): Promise<void> {
  const profileId = existingProfileId ?? generateWalletControlProfileId();

  if (!existingProfileId) {
    await db
      .prepare(
        `INSERT INTO wallet_control_profiles (
           id,
           organization_id,
           project_id,
           custody_wallet_id,
           name,
           status,
           created_by
         ) VALUES (?, ?, ?, ?, ?, 'draft', ?)`
      )
      .bind(profileId, organizationId, projectId, custodyWalletId, profileName, createdBy)
      .run();
  }

  const revisionId = generateWalletControlProfileRevisionId();
  const revision = await db
    .prepare(
      `INSERT INTO wallet_control_profile_revisions (
         id,
         profile_id,
         revision_number,
         rules,
         default_action,
         commit_message,
         created_by
       )
       SELECT
         ?,
         ?,
         COALESCE(MAX(revision_number), 0) + 1,
         ?::jsonb,
         ?,
         ?,
         ?
       FROM wallet_control_profile_revisions
       WHERE profile_id = ?
       RETURNING id`
    )
    .bind(
      revisionId,
      profileId,
      JSON.stringify(rules),
      defaultAction,
      commitMessage === undefined ? null : commitMessage,
      createdBy,
      profileId
    )
    .first<{ id: string }>();

  if (!revision) {
    throw new AppError("INTERNAL_ERROR", "Failed to create wallet control profile revision");
  }

  const activatedRevision = await db
    .prepare(
      `UPDATE wallet_control_profile_revisions
       SET activated_at = COALESCE(activated_at, ?)
       WHERE id = ? AND profile_id = ?
       RETURNING id`
    )
    .bind(activatedAt, revisionId, profileId)
    .first<{ id: string }>();

  if (!activatedRevision) {
    throw new AppError("INTERNAL_ERROR", "Failed to activate wallet control profile revision");
  }

  const activatedProfile = await db
    .prepare(
      `UPDATE wallet_control_profiles
       SET status = 'active',
           active_revision_id = ?,
           activated_at = COALESCE(activated_at, ?),
           updated_at = ?
       WHERE id = ?
       RETURNING id`
    )
    .bind(revisionId, activatedAt, activatedAt, profileId)
    .first<{ id: string }>();

  if (!activatedProfile) {
    throw new AppError("INTERNAL_ERROR", "Failed to activate wallet control profile revision");
  }
}

export async function getWalletBalances(c: AppContext) {
  const { wallet } = await resolveWalletFromParams(c, ["wallets:read"]);

  const rpc = solanaRpc.createRpc(c.env);
  const tokenLabelsByMint = await resolveIssuedTokenLabelsByMint(c);
  let lamports = 0n;
  let splBalances: Awaited<ReturnType<typeof tokenAccounts.getSplTokenBalances>> = [];

  try {
    const accountInfo = await solanaRpc.getAccountInfo(rpc, wallet.publicKey as Address);
    lamports = accountInfo?.lamports ?? 0n;
  } catch (error) {
    getLogger().error(
      {
        requestId: c.get("requestId"),
        walletId: wallet.walletId,
        publicKey: wallet.publicKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "getWalletBalances: failed to fetch SOL balance"
    );
  }

  try {
    splBalances = await tokenAccounts.getSplTokenBalances(rpc, wallet.publicKey as Address, {
      tokenLabelsByMint,
    });
  } catch (error) {
    getLogger().error(
      {
        requestId: c.get("requestId"),
        walletId: wallet.walletId,
        publicKey: wallet.publicKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "getWalletBalances: failed to fetch SPL balances"
    );
  }

  const labeledBalances = await attachTokenSymbolsToBalances(c.env, [
    {
      token: "SOL",
      mint: tokenAccounts.SOL_MINT,
      amount: lamports.toString(),
      uiAmount: formatDecimalAmount(lamports, 9),
      decimals: 9,
    },
    ...splBalances,
  ]);
  const balances = await attachUsdValuesToBalances(c.env, labeledBalances);

  return success(c, {
    walletBalances: {
      walletId: wallet.walletId,
      address: wallet.publicKey,
      balances,
    },
  });
}

export async function getWalletPolicy(c: AppContext) {
  const { auth, wallet } = await resolveWalletFromParams(c, ["wallets:read"]);
  const repository = getPaymentsRepository(c);

  const rows = await repository.getWalletPoliciesByCustodyWalletId(wallet.id);
  const payload = buildWalletPolicyPayload(wallet.walletId, rows, wallet.createdAt);
  const controlProfile = await getWalletControlProfileSummary(c, wallet.id);
  const audit = await getWalletPolicyAudit(c, {
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? null,
    custodyWalletId: wallet.id,
  });

  return success(c, {
    policy: {
      ...payload,
      audit,
      ...(controlProfile
        ? {
            defaultAction: controlProfile.defaultAction,
            rules: controlProfile.rules,
            controlProfile,
          }
        : {}),
    },
  });
}

export async function updateWalletPolicy(c: AppContext) {
  const { auth, wallet } = await resolveWalletFromParams(c, ["wallets:write"]);

  const body = await c.req.json();
  const parsed = updateWalletPolicySchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const patch = parsed.data;
  const now = new Date().toISOString();

  const { rows, controlProfile } = await getDb(c.env).transaction(async (tx) => {
    // Serialize concurrent policy updates for this wallet so read-merge-write
    // cannot interleave and silently drop another request's controls.
    const lockedWallet = await tx
      .prepare(`SELECT id FROM custody_wallets WHERE id = ? FOR UPDATE`)
      .bind(wallet.id)
      .first<{ id: string }>();

    if (!lockedWallet) {
      throw new AppError("NOT_FOUND", "Wallet not found");
    }

    const txRepository = createPostgresPaymentsRepository(tx, getRequestTenantScope(c));
    const currentRows = await txRepository.getWalletPoliciesByCustodyWalletId(wallet.id);
    const current = buildWalletPolicyPayload(wallet.walletId, currentRows, wallet.createdAt);
    const activeProfile = await lockActiveWalletControlProfile(tx, wallet.id);
    const activeRevisionId = activeProfile?.revision_id ?? null;

    if (patch.expectedRevisionId !== undefined && patch.expectedRevisionId !== activeRevisionId) {
      throw conflict(
        "Wallet policy was changed by another update; refresh and retry with the current revision"
      );
    }

    const merged = mergeWalletPolicyPatch(
      {
        destinationAllowlist: current.destinationAllowlist,
        maxTransferAmount: current.maxTransferAmount,
        maxDailyAmount: current.maxDailyAmount,
        controlProfile: activeProfile?.revision_id
          ? {
              rules: asPostgresJsonArray(activeProfile.rules) as unknown as PolicyRule[],
              defaultAction: activeProfile.default_action ?? "allow",
            }
          : null,
      },
      patch
    );

    const savedRows = await txRepository.upsertWalletPolicies([
      {
        id: `pwp_${crypto.randomUUID()}`,
        custodyWalletId: wallet.id,
        policyType: DESTINATION_ALLOWLIST_POLICY_TYPE,
        policy: JSON.stringify({
          version: PAYMENT_POLICY_VERSION,
          destinationAllowlist: merged.destinationAllowlist,
        }),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `pwp_${crypto.randomUUID()}`,
        custodyWalletId: wallet.id,
        policyType: TRANSFER_LIMITS_POLICY_TYPE,
        policy: JSON.stringify({
          version: PAYMENT_POLICY_VERSION,
          maxTransferAmount: merged.maxTransferAmount ?? null,
          maxDailyAmount: merged.maxDailyAmount ?? null,
        }),
        createdAt: now,
        updatedAt: now,
      },
    ]);

    if (savedRows.length === 0) {
      throw new AppError("INTERNAL_ERROR", "Failed to persist wallet policy");
    }

    if (patch.rules !== undefined || patch.defaultAction !== undefined) {
      await activateWalletControlProfileRevisionInTransaction({
        db: tx,
        existingProfileId: activeProfile?.profile_id ?? null,
        organizationId: auth.organizationId,
        projectId: auth.projectId ?? null,
        custodyWalletId: wallet.id,
        profileName: `${wallet.label ?? wallet.walletId} controls`,
        rules: merged.controlProfile?.rules ?? [],
        defaultAction: merged.controlProfile?.defaultAction ?? "allow",
        commitMessage: patch.commitMessage,
        createdBy: auth.userId ?? auth.apiKeyId ?? null,
        activatedAt: now,
      });
    }

    return {
      rows: savedRows,
      controlProfile: await readWalletControlProfileSummaryInTransaction(tx, wallet.id),
    };
  });

  const payload = buildWalletPolicyPayload(wallet.walletId, rows, now);
  const audit = await getWalletPolicyAudit(c, {
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? null,
    custodyWalletId: wallet.id,
  });

  return success(c, {
    policy: {
      ...payload,
      audit,
      ...(controlProfile
        ? {
            defaultAction: controlProfile.defaultAction,
            rules: controlProfile.rules,
            controlProfile,
          }
        : {}),
    },
  });
}
