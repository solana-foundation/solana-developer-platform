import { badRequest } from "@sdp/payments/errors";
import { isAddress } from "@sdp/solana/address";
import type { Permission } from "@sdp/types";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, conflict, walletNotFound } from "@/lib/errors";
import {
  assertApiKeyWalletAccess,
  assertFreshApiKeyCustodyWalletAccess,
  getAllowedApiKeyCustodyWalletIdsForPermissions,
  resolveApiKeyCustodyWalletId,
} from "@/services/api-key-scope.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { AppContext } from "./context";

async function findRetainedPaymentWallet(
  c: AppContext,
  custodyWalletId: string
): Promise<CustodyWallet | null> {
  const auth = getAuth(c);
  const row = await getDb(c.env)
    .prepare(
      `SELECT w.id, w.custody_config_id, w.custody_connection_id,
              w.wallet_id, w.public_key, w.label, w.purpose, w.status, w.created_at
       FROM custody_wallets w
       LEFT JOIN custody_configs cfg ON cfg.id = w.custody_config_id
       LEFT JOIN custody_connections conn ON conn.id = w.custody_connection_id
       WHERE w.id = ?
         AND ((cfg.organization_id = ? AND (cfg.project_id = ? OR cfg.project_id IS NULL))
           OR (conn.organization_id = ? AND conn.project_id = ?))
       LIMIT 1`
    )
    .bind(custodyWalletId, auth.organizationId, auth.projectId, auth.organizationId, auth.projectId)
    .first<{
      id: string;
      custody_config_id: string | null;
      custody_connection_id: string | null;
      wallet_id: string;
      public_key: string;
      label: string | null;
      purpose: CustodyWallet["purpose"];
      status: CustodyWallet["status"];
      created_at: string;
    }>();

  if (!row) {
    return null;
  }
  const wallet = {
    id: row.id,
    walletId: row.wallet_id,
    publicKey: row.public_key,
    label: row.label,
    purpose: row.purpose,
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.custody_config_id) {
    return { ...wallet, custodyConfigId: row.custody_config_id };
  }
  if (row.custody_connection_id) {
    return { ...wallet, custodyConnectionId: row.custody_connection_id };
  }
  return null;
}

export async function resolveScope(c: AppContext, retainedCustodyWalletId?: string) {
  const auth = getAuth(c);
  const [operationalWallets, retainedWallet] = await Promise.all([
    new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets({
      organizationId: auth.organizationId,
      projectId: auth.projectId ?? undefined,
      includeAllProviders: true,
    }),
    retainedCustodyWalletId
      ? findRetainedPaymentWallet(c, retainedCustodyWalletId)
      : Promise.resolve(null),
  ]);
  const wallets: CustodyWallet[] = operationalWallets;
  if (retainedWallet && !wallets.some((wallet) => wallet.id === retainedWallet.id)) {
    wallets.push(retainedWallet);
  }

  return {
    auth,
    wallets,
  };
}

export type ResolvedScope = Awaited<ReturnType<typeof resolveScope>>;

export async function resolvePolicyWalletFromParams(
  c: AppContext,
  requiredWalletPermissions: Permission[]
) {
  const auth = getAuth(c);
  const walletId = c.req.param("walletId");
  if (!walletId) {
    throw walletNotFound();
  }
  const targets = new CustodyRuntimeTargets(getDb(c.env), c.env, new Map());
  const custodyWalletId = resolveApiKeyCustodyWalletId(auth, walletId, requiredWalletPermissions);
  const wallet = custodyWalletId
    ? await targets.findOperationalWalletById({
        organizationId: auth.organizationId,
        projectId: auth.projectId ?? undefined,
        custodyWalletId,
      })
    : await targets.findOperationalWallet({
        organizationId: auth.organizationId,
        projectId: auth.projectId ?? undefined,
        walletId,
      });
  if (!wallet) {
    throw walletNotFound();
  }
  return { auth, wallet };
}

export function resolveWallet(wallets: CustodyWallet[], walletId: string): CustodyWallet {
  const matches = wallets.filter((entry) => entry.walletId === walletId);
  if (matches.length > 1) {
    throw conflict("Custody wallet ownership is ambiguous");
  }
  const wallet = matches[0];
  if (!wallet) {
    throw walletNotFound();
  }
  return wallet;
}

export function resolveWalletByCustodyWalletId(
  wallets: CustodyWallet[],
  custodyWalletId: string
): CustodyWallet {
  const wallet = wallets.find((entry) => entry.id === custodyWalletId);
  if (!wallet) {
    throw walletNotFound();
  }
  return wallet;
}

export async function assertFreshPaymentWalletAccess(
  c: AppContext,
  wallet: CustodyWallet,
  requiredWalletPermissions: Permission[]
): Promise<void> {
  await assertFreshApiKeyCustodyWalletAccess(
    getDb(c.env),
    getAuth(c),
    wallet.id,
    requiredWalletPermissions
  );
}

export function assertPaymentWalletExactAccess(
  c: AppContext,
  custodyWalletId: string,
  requiredWalletPermissions: Permission[]
): void {
  const allowedCustodyWalletIds = getAllowedApiKeyCustodyWalletIdsForPermissions(
    getAuth(c),
    requiredWalletPermissions
  );
  if (allowedCustodyWalletIds && !allowedCustodyWalletIds.includes(custodyWalletId)) {
    throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
  }
}

export async function admitExactPaymentWallet(
  c: AppContext,
  wallet: CustodyWallet,
  requiredWalletPermissions: Permission[]
): Promise<void> {
  await assertFreshPaymentWalletAccess(c, wallet, requiredWalletPermissions);
  await admitPaymentWalletRuntimeExecution(c, wallet);
}

export async function admitPaymentWalletRuntimeExecution(
  c: AppContext,
  wallet: CustodyWallet
): Promise<void> {
  const auth = getAuth(c);
  await createSigningService(c.env).admitRuntimeExecution(
    auth.organizationId,
    auth.projectId ?? undefined,
    wallet.id
  );
}

export function assertPaymentWalletReadAccess(
  c: AppContext,
  wallet: { custodyWalletId: string | null; providerWalletId: string }
): void {
  const auth = getAuth(c);
  if (wallet.custodyWalletId) {
    const allowedCustodyWalletIds = getAllowedApiKeyCustodyWalletIdsForPermissions(auth, [
      "payments:read",
    ]);
    if (allowedCustodyWalletIds && !allowedCustodyWalletIds.includes(wallet.custodyWalletId)) {
      throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
    }
    return;
  }

  assertApiKeyWalletAccess(auth, wallet.providerWalletId, ["payments:read"]);
}

export function resolveWalletAddress(
  wallets: CustodyWallet[],
  walletIdOrAddress: string,
  fieldName: string,
  auth?: ReturnType<typeof getAuth>,
  requiredWalletPermissions: Permission[] = []
): string {
  const matchingWallets = wallets.filter(
    (entry) => entry.walletId === walletIdOrAddress || entry.publicKey === walletIdOrAddress
  );
  if (matchingWallets.length > 1) {
    throw conflict("Custody wallet ownership is ambiguous");
  }
  const matchingWallet = matchingWallets[0];
  if (matchingWallet) {
    if (auth) {
      assertApiKeyWalletAccess(auth, matchingWallet.walletId, requiredWalletPermissions);
    }
    return matchingWallet.publicKey;
  }
  if (!isAddress(walletIdOrAddress)) {
    throw badRequest(
      `${fieldName} must be a \`walletId\` returned by GET /v1/wallets or a valid Solana address, got: ${walletIdOrAddress}`
    );
  }
  return walletIdOrAddress;
}
