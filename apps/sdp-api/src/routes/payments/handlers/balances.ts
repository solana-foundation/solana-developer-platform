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
import { type DatabaseExecutor, getDb } from "@/db";
import { asPostgresJsonArray } from "@/db/postgres-utils";
import type {
  ActiveWalletControlProfileResult,
  WalletPolicyEvaluationAuditRow,
} from "@/db/repositories";
import {
  generateWalletControlProfileId,
  generateWalletControlProfileRevisionId,
} from "@/db/repositories/policy.repository";
import { AppError, conflict, walletNotFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import {
  attachTokenSymbolsToBalances,
  attachUsdValuesToBalances,
} from "@/services/helius-das.service";
import { type AppContext, getPolicyRepository } from "../context";
import type { updateWalletPolicySchema } from "../schemas";
import * as tokenAccounts from "../token-accounts";
import { resolveIssuedTokenLabelsByMint } from "../token-labels";
import { resolvePolicyWalletFromParams } from "../wallets";

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
 * Locks the wallet's active profile and returns its active revision id. Taken
 * before the merge base is read so a concurrent update cannot interleave.
 */
async function lockActiveWalletControlProfile(
  db: DatabaseExecutor,
  custodyWalletId: string
): Promise<{ profile_id: string; revision_id: string | null } | null> {
  return await db
    .prepare(
      `SELECT p.id AS profile_id, p.active_revision_id AS revision_id
       FROM wallet_control_profiles p
       WHERE p.custody_wallet_id = ?
         AND p.status = 'active'
       ORDER BY p.activated_at DESC NULLS LAST, p.created_at DESC
       LIMIT 1
       FOR UPDATE`
    )
    .bind(custodyWalletId)
    .first<{ profile_id: string; revision_id: string | null }>();
}

/**
 * Must run on the update transaction's connection: a post-commit read could
 * mix a concurrent update's profile into this request's response.
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
  const existingProfile = existingProfileId === null ? null : { id: existingProfileId };

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
  const { wallet } = await resolvePolicyWalletFromParams(c, ["wallets:read"]);

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
  const { auth, wallet } = await resolvePolicyWalletFromParams(c, ["wallets:read"]);

  const controlProfile = await getWalletControlProfileSummary(c, wallet.id);
  const audit = await getWalletPolicyAudit(c, {
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? null,
    custodyWalletId: wallet.id,
  });

  return success(c, { policy: walletPolicyResponse(wallet.walletId, controlProfile, audit) });
}

export async function updateWalletPolicy(c: ValidatedBodyContext<typeof updateWalletPolicySchema>) {
  const { auth, wallet } = await resolvePolicyWalletFromParams(c, ["wallets:write"]);

  const body = c.req.valid("json");

  const now = new Date().toISOString();
  const controlProfile = await getDb(c.env).transaction(async (tx) => {
    // Serializes per-wallet updates. Locking the profile alone is not enough:
    // a wallet without one has no row to lock, so concurrent first writes
    // would each insert their own profile.
    const lockedWallet = await tx
      .prepare(`SELECT id FROM custody_wallets WHERE id = ? FOR UPDATE`)
      .bind(wallet.id)
      .first<{ id: string }>();

    if (!lockedWallet) {
      throw walletNotFound();
    }

    const activeProfile = await lockActiveWalletControlProfile(tx, wallet.id);

    if (
      body.expectedRevisionId !== undefined &&
      body.expectedRevisionId !== (activeProfile?.revision_id ?? null)
    ) {
      throw conflict(
        "Wallet policy was changed by another update; refresh and retry with the current revision"
      );
    }

    await activateWalletControlProfileRevisionInTransaction({
      db: tx,
      existingProfileId: activeProfile?.profile_id ?? null,
      organizationId: auth.organizationId,
      projectId: auth.projectId ?? null,
      custodyWalletId: wallet.id,
      profileName: `${wallet.label ?? wallet.walletId} controls`,
      rules: body.rules,
      defaultAction: body.defaultAction,
      commitMessage: body.commitMessage,
      createdBy: auth.userId ?? auth.apiKeyId ?? null,
      activatedAt: now,
    });

    return await readWalletControlProfileSummaryInTransaction(tx, wallet.id);
  });

  const audit = await getWalletPolicyAudit(c, {
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? null,
    custodyWalletId: wallet.id,
  });

  return success(c, { policy: walletPolicyResponse(wallet.walletId, controlProfile, audit) });
}
