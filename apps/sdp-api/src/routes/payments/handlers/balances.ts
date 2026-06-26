import type {
  PaymentWalletControlProfileSummary,
  PolicyDefaultAction,
  PolicyRule,
} from "@sdp/types";
import type { Address } from "@solana/kit";
import { z } from "zod";
import { type DatabaseExecutor, getDb } from "@/db";
import {
  type ActiveWalletControlProfileResult,
  createPostgresPaymentsRepository,
} from "@/db/repositories";
import {
  generateWalletControlProfileId,
  generateWalletControlProfileRevisionId,
} from "@/db/repositories/policy.repository";
import { formatDecimalAmount } from "@/lib/amount";
import { AppError, badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import { attachUsdValuesToBalances } from "@/services/helius-das.service";
import * as solanaRpc from "@/services/solana/rpc";
import { type AppContext, getPaymentsRepository, getPolicyRepository } from "../context";
import {
  buildWalletPolicyPayload,
  DESTINATION_ALLOWLIST_POLICY_TYPE,
  PAYMENT_POLICY_VERSION,
  TRANSFER_LIMITS_POLICY_TYPE,
} from "../policy";
import { updateWalletPolicySchema } from "../schemas";
import * as tokenAccounts from "../token-accounts";
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

async function activateWalletControlProfileRevisionInTransaction({
  db,
  organizationId,
  projectId,
  custodyWalletId,
  profileName,
  rules,
  defaultAction,
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
         created_by
       )
       SELECT
         ?,
         ?,
         COALESCE(MAX(revision_number), 0) + 1,
         ?::jsonb,
         ?,
         ?
       FROM wallet_control_profile_revisions
       WHERE profile_id = ?
       RETURNING id`
    )
    .bind(revisionId, profileId, JSON.stringify(rules), defaultAction, createdBy, profileId)
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
  let lamports = 0n;
  let splBalances: Awaited<ReturnType<typeof tokenAccounts.getSplTokenBalances>> = [];

  try {
    const accountInfo = await solanaRpc.getAccountInfo(rpc, wallet.publicKey as Address);
    lamports = accountInfo?.lamports ?? 0n;
  } catch (error) {
    console.error("getWalletBalances: failed to fetch SOL balance", {
      requestId: c.get("requestId"),
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    splBalances = await tokenAccounts.getSplTokenBalances(rpc, wallet.publicKey as Address);
  } catch (error) {
    console.error("getWalletBalances: failed to fetch SPL balances", {
      requestId: c.get("requestId"),
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const balances = await attachUsdValuesToBalances(c.env, [
    {
      token: "SOL",
      mint: tokenAccounts.SOL_MINT,
      amount: lamports.toString(),
      uiAmount: formatDecimalAmount(lamports, 9),
      decimals: 9,
    },
    ...splBalances,
  ]);

  return success(c, {
    walletBalances: {
      walletId: wallet.walletId,
      address: wallet.publicKey,
      balances,
    },
  });
}

export async function getWalletPolicy(c: AppContext) {
  const { wallet } = await resolveWalletFromParams(c, ["wallets:read"]);
  const repository = getPaymentsRepository(c);

  const rows = await repository.getWalletPoliciesByCustodyWalletId(wallet.id);
  const payload = buildWalletPolicyPayload(wallet.walletId, rows, wallet.createdAt);
  const controlProfile = await getWalletControlProfileSummary(c, wallet.id);

  return success(c, {
    policy: {
      ...payload,
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
  const repository = getPaymentsRepository(c);

  const body = await c.req.json();
  const parsed = updateWalletPolicySchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const now = new Date().toISOString();
  const walletPolicyInputs = [
    {
      id: `pwp_${crypto.randomUUID()}`,
      custodyWalletId: wallet.id,
      policyType: DESTINATION_ALLOWLIST_POLICY_TYPE,
      policy: JSON.stringify({
        version: PAYMENT_POLICY_VERSION,
        destinationAllowlist: parsed.data.destinationAllowlist,
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
        maxTransferAmount: parsed.data.maxTransferAmount ?? null,
        maxDailyAmount: parsed.data.maxDailyAmount ?? null,
      }),
      createdAt: now,
      updatedAt: now,
    },
  ];

  let controlProfile: PaymentWalletControlProfileSummary | null = null;
  let rows: Awaited<ReturnType<typeof repository.upsertWalletPolicies>>;
  if (parsed.data.rules || parsed.data.defaultAction) {
    rows = await getDb(c.env).transaction(async (tx) => {
      const txRepository = createPostgresPaymentsRepository(tx);
      const savedRows = await txRepository.upsertWalletPolicies(walletPolicyInputs);

      if (savedRows.length === 0) {
        throw new AppError("INTERNAL_ERROR", "Failed to persist wallet policy");
      }

      await activateWalletControlProfileRevisionInTransaction({
        db: tx,
        organizationId: auth.organizationId,
        projectId: auth.projectId ?? null,
        custodyWalletId: wallet.id,
        profileName: `${wallet.label ?? wallet.walletId} controls`,
        rules: parsed.data.rules ?? [],
        defaultAction: parsed.data.defaultAction ?? "allow",
        createdBy: auth.userId ?? auth.apiKeyId ?? null,
        activatedAt: now,
      });

      return savedRows;
    });

    controlProfile = await getWalletControlProfileSummary(c, wallet.id);
  } else {
    rows = await repository.upsertWalletPolicies(walletPolicyInputs);

    if (rows.length === 0) {
      throw new AppError("INTERNAL_ERROR", "Failed to persist wallet policy");
    }

    controlProfile = await getWalletControlProfileSummary(c, wallet.id);
  }

  const payload = buildWalletPolicyPayload(wallet.walletId, rows, now);

  return success(c, {
    policy: {
      ...payload,
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
