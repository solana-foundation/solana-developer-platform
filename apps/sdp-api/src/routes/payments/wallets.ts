import { badRequest } from "@sdp/payments/errors";
import { isAddress } from "@solana/addresses";
import { getDb } from "@/db/client";
import { getAuth, requireProjectId, walletAccessAllows } from "@/lib/auth";
import { conflict, walletNotFound } from "@/lib/errors";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { AppContext } from "./context";

/**
 * A custody wallet of the caller's project by its id, whatever its status: for an
 * access check, where whether the wallet is active is state for the handler.
 */
export function findRetainedPaymentWallet(
  c: AppContext,
  custodyWalletId: string
): Promise<CustodyWallet | null> {
  return findProjectPaymentWallet(c, "id", custodyWalletId);
}

/** {@link findRetainedPaymentWallet}, by the provider wallet ID a request names. */
export function findRetainedPaymentWalletByWalletId(
  c: AppContext,
  walletId: string
): Promise<CustodyWallet | null> {
  return findProjectPaymentWallet(c, "wallet_id", walletId);
}

async function findProjectPaymentWallet(
  c: AppContext,
  column: "id" | "wallet_id",
  value: string
): Promise<CustodyWallet | null> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const row = await getDb(c.env)
    .prepare(
      `SELECT w.id, w.custody_config_id, w.custody_connection_id,
              w.wallet_id, w.public_key, w.label, w.purpose, w.status, w.created_at
       FROM custody_wallets w
       LEFT JOIN custody_configs cfg ON cfg.id = w.custody_config_id
       LEFT JOIN custody_connections conn ON conn.id = w.custody_connection_id
       WHERE w.${column} = ?
         AND ((cfg.organization_id = ? AND cfg.project_id = ?)
           OR (conn.organization_id = ? AND conn.project_id = ?))
       LIMIT 1`
    )
    .bind(value, auth.organizationId, projectId, auth.organizationId, projectId)
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

export async function resolveScope(c: AppContext, retainedCustodyWalletId?: string | null) {
  const auth = getAuth(c);
  const [operationalWallets, retainedWallet] = await Promise.all([
    new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets({
      organizationId: auth.organizationId,
      projectId: requireProjectId(c),
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

/**
 * Resolve the wallet addressed by the `walletId` route param (the wallet
 * balances route). A wallet detail read, so a selected API key sees only the
 * wallets it lists (HOO-2099); any other is not found.
 *
 * @param c - Request context.
 * @returns The auth context and the resolved operational wallet.
 */
export async function resolveWalletFromParams(c: AppContext) {
  const auth = getAuth(c);
  const walletId = c.req.param("walletId");
  if (!walletId) {
    throw walletNotFound();
  }
  const wallet = await new CustodyRuntimeTargets(
    getDb(c.env),
    c.env,
    new Map()
  ).findOperationalWallet({
    organizationId: auth.organizationId,
    projectId: requireProjectId(c),
    walletId,
  });
  if (!wallet || !walletAccessAllows(auth.walletAccess, wallet.id)) {
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

export async function admitPaymentWalletRuntimeExecution(
  c: AppContext,
  wallet: CustodyWallet
): Promise<void> {
  const auth = getAuth(c);
  await createSigningService(c.env).admitRuntimeExecution(
    auth.organizationId,
    requireProjectId(c),
    wallet.id
  );
}

export function resolveWalletAddress(
  wallets: CustodyWallet[],
  walletIdOrAddress: string,
  fieldName: string
): string {
  const matchingWallets = wallets.filter(
    (entry) => entry.walletId === walletIdOrAddress || entry.publicKey === walletIdOrAddress
  );
  if (matchingWallets.length > 1) {
    throw conflict("Custody wallet ownership is ambiguous");
  }
  const matchingWallet = matchingWallets[0];
  if (matchingWallet) {
    return matchingWallet.publicKey;
  }
  if (!isAddress(walletIdOrAddress)) {
    throw badRequest(
      `${fieldName} must be a \`walletId\` returned by GET /v1/wallets or a valid Solana address, got: ${walletIdOrAddress}`
    );
  }
  return walletIdOrAddress;
}
