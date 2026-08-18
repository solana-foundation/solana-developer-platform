import * as solanaRpc from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import type {
  PaymentWalletControlProfileSummary,
  PaymentWalletPolicy,
  PaymentWalletPolicyAudit,
  PaymentWalletPolicyAuditEntry,
  PolicyDefaultAction,
  PolicyRule,
} from "@sdp/types";
import type { Address } from "@solana/kit";
import { z } from "zod";
import { type DatabaseExecutor, getDb } from "@/db";
import type {
  ActiveWalletControlProfileResult,
  WalletPolicyEvaluationAuditRow,
} from "@/db/repositories";
import {
  generateWalletControlProfileId,
  generateWalletControlProfileRevisionId,
} from "@/db/repositories/policy.repository";
import { getAuth } from "@/lib/auth";
import { AppError, badRequest, walletNotFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getLogger } from "@/runtime/logger";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import {
  attachTokenSymbolsToBalances,
  attachUsdValuesToBalances,
} from "@/services/helius-das.service";
import { type AppContext, getPolicyRepository } from "../context";
import { updateWalletPolicySchema, walletIdParamsSchema } from "../schemas";
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

async function activateWalletControlProfileRevisionInTransaction({
  db,
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
  const existingProfile = await db
    .prepare(
      `SELECT id
       FROM wallet_control_profiles
       WHERE custody_wallet_id = ?
         AND status = 'active'
       ORDER BY activated_at DESC NULLS LAST, created_at DESC
       LIMIT 1
       FOR UPDATE`
    )
    .bind(custodyWalletId)
    .first<{ id: string }>();

  const profileId = existingProfile?.id ?? generateWalletControlProfileId();

  if (!existingProfile) {
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
  const params = walletIdParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequest("Invalid wallet ID");
  }

  const auth = getAuth(c);
  const wallet = await new CustodyRuntimeTargets(
    getDb(c.env),
    c.env,
    new Map()
  ).findOperationalWallet({
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? undefined,
    walletId: params.data.walletId,
  });
  if (!wallet) {
    throw walletNotFound();
  }
  assertApiKeyWalletAccess(auth, wallet.walletId, ["wallets:read"]);

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

/**
 * Shape a wallet's control profile into the policies API response. A wallet
 * without an active profile is implicitly default-allow with no rules.
 *
 * @param walletId - The wallet the policy belongs to.
 * @param controlProfile - The wallet's active control profile, if any.
 * @param audit - The wallet's recent policy evaluations.
 * @returns The policy response payload.
 */
function walletPolicyResponse(
  walletId: string,
  controlProfile: PaymentWalletControlProfileSummary | null,
  audit: PaymentWalletPolicyAudit
): PaymentWalletPolicy {
  return {
    walletId,
    defaultAction: controlProfile === null ? "allow" : controlProfile.defaultAction,
    rules: controlProfile === null ? [] : controlProfile.rules,
    controlProfile,
    audit,
  };
}

export async function getWalletPolicy(c: AppContext) {
  const { auth, wallet } = await resolveWalletFromParams(c, ["wallets:read"]);

  const controlProfile = await getWalletControlProfileSummary(c, wallet.id);
  const audit = await getWalletPolicyAudit(c, {
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? null,
    custodyWalletId: wallet.id,
  });

  return success(c, { policy: walletPolicyResponse(wallet.walletId, controlProfile, audit) });
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

  const now = new Date().toISOString();
  await getDb(c.env).transaction(async (tx) => {
    await activateWalletControlProfileRevisionInTransaction({
      db: tx,
      organizationId: auth.organizationId,
      projectId: auth.projectId ?? null,
      custodyWalletId: wallet.id,
      profileName: `${wallet.label ?? wallet.walletId} controls`,
      rules: parsed.data.rules,
      defaultAction: parsed.data.defaultAction,
      commitMessage: parsed.data.commitMessage,
      createdBy: auth.userId ?? auth.apiKeyId ?? null,
      activatedAt: now,
    });
  });

  const controlProfile = await getWalletControlProfileSummary(c, wallet.id);
  const audit = await getWalletPolicyAudit(c, {
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? null,
    custodyWalletId: wallet.id,
  });

  return success(c, { policy: walletPolicyResponse(wallet.walletId, controlProfile, audit) });
}
