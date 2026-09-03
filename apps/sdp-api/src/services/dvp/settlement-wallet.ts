/**
 * The custody wallet that settles a project's DvP trades.
 *
 * Only this key can Settle or Cancel. It is one of the six PDA seeds, so it is
 * fixed in a trade's address at creation: rotating a project's settlement
 * wallet does not migrate existing trades, and they stay settleable only by the
 * wallet that created them. That is why the mapping is stored rather than
 * derived, and why the wallet cannot be deleted while it is in use.
 *
 * It also cannot be either party — the program refuses
 * `settlement_authority == user_a || == user_b`, and `validateDvpTerms` refuses
 * it first. So this is deliberately a SEPARATE wallet from the one holding
 * SDP's leg, never a reuse of it.
 */

import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import { provisionApiKeyWallet } from "@/services/api-key-wallet-provisioning.service";
import type { Env } from "@/types/env";

/** Shown in the custody wallet list so this wallet is not a mystery row. */
const SETTLEMENT_WALLET_LABEL = "DvP settlement authority";

export interface DvpSettlementWallet {
  /** `custody_wallets.id` — what the signer resolver takes. */
  custodyWalletId: string;
  /** The on-chain address, which is what the PDA seeds use. */
  address: string;
}

interface Scope {
  organizationId: string;
  projectId: string;
}

/**
 * Returns the project's settlement wallet, provisioning one on first use.
 *
 * Safe to call concurrently. Two racing trade creations both mint a provider
 * wallet — that part cannot be made atomic, because it is a call out to
 * Fireblocks or Turnkey — but only one wins the insert, and the loser returns
 * the winner's wallet. The loser's wallet is left orphaned and logged rather
 * than deleted: it holds no funds, and deleting a freshly provisioned key on a
 * race is a worse failure mode than leaving an unused one behind.
 *
 * @param env - API process environment.
 * @param scope - Organization and project the trade belongs to.
 * @returns The settlement wallet's record id and address.
 */
export async function getOrCreateDvpSettlementWallet(
  env: Env,
  scope: Scope
): Promise<DvpSettlementWallet> {
  const existing = await readSettlementWallet(env, scope);
  if (existing) {
    return existing;
  }

  // Reaching here with a mapping already present means its wallet was
  // deactivated. A replacement lets NEW trades be created, but it cannot rescue
  // the old ones: their authority is baked into their address, so every open
  // trade under the dead wallet is now unsettleable by anyone. That is worth
  // saying out loud rather than papering over.
  const replacing = await readMappedWalletId(env, scope);
  if (replacing) {
    getLogger().warn(
      { projectId: scope.projectId, deactivatedCustodyWalletId: replacing },
      "dvp: the project's settlement wallet is no longer active; provisioning a replacement. Trades created under the old authority can no longer be settled or cancelled by anyone."
    );
  }

  const provisioned = await provisionApiKeyWallet(getDb(env), env, {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    // Both, and they are NOT the same argument. `projectId` scopes the custody
    // CONNECTION lookup; `legacyConfigProjectId` scopes the custody CONFIG one,
    // and omitting it makes the fallback ask for the organization-wide default
    // (`custody-config.store.ts:151`, `project_id IS NULL`).
    //
    // Almost no organization has one. The dashboard writes a project-scoped
    // `custody_scope_defaults` row, so the org-wide lookup finds nothing and
    // provisioning fails with "Custody not initialized" — on an organization
    // whose custody is configured and working. That made every first DvP trade
    // in a project fail, because creating one provisions this wallet.
    legacyConfigProjectId: scope.projectId,
    label: SETTLEMENT_WALLET_LABEL,
  });

  const claimed = await getDb(env)
    .prepare(
      `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
       VALUES (?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE
          SET custody_wallet_id = EXCLUDED.custody_wallet_id,
              updated_at = sdp_iso_now()
        WHERE EXISTS (
          -- Only replace an authority that can no longer sign. Without this
          -- guard a concurrent caller would overwrite a live mapping, and
          -- trades already created under the replaced wallet would be
          -- permanently unsettleable — the authority is in their address.
          SELECT 1 FROM custody_wallets w
           WHERE w.id = dvp_settlement_wallets.custody_wallet_id
             AND w.status <> 'active'
        )
       RETURNING custody_wallet_id`
    )
    .bind(scope.projectId, scope.organizationId, provisioned.id)
    .first<{ custody_wallet_id: string }>();

  if (!claimed) {
    // Someone else got there first. Their wallet is the project's authority —
    // trades they create are already bound to it — so ours is discarded.
    const winner = await readSettlementWallet(env, scope);
    if (!winner) {
      throw new Error("DvP settlement wallet was claimed concurrently but cannot be read back");
    }
    getLogger().warn(
      { projectId: scope.projectId, orphanedCustodyWalletId: provisioned.id },
      "dvp: lost the settlement-wallet provisioning race; the wallet just minted is unused"
    );
    return winner;
  }

  // Re-read rather than trusting the provisioner's return. It answers with the
  // PROVIDER's wallet id, which is not the Solana public key — and the public
  // key is what becomes a PDA seed, so using the wrong one would derive trade
  // addresses that no key can ever settle.
  const stored = await readSettlementWallet(env, scope);
  if (!stored) {
    throw new Error("DvP settlement wallet was written but cannot be read back");
  }
  return stored;
}

/** The mapped wallet id regardless of whether that wallet can still sign. */
async function readMappedWalletId(env: Env, scope: Scope): Promise<string | null> {
  const row = await getDb(env)
    .prepare(
      "SELECT custody_wallet_id FROM dvp_settlement_wallets WHERE project_id = ? AND organization_id = ?"
    )
    .bind(scope.projectId, scope.organizationId)
    .first<{ custody_wallet_id: string }>();
  return row?.custody_wallet_id ?? null;
}

/**
 * Reads the project's settlement wallet, or null when it has none yet.
 *
 * Joins through to `custody_wallets` for the public key, and requires the
 * wallet to still be active: a deactivated settlement wallet cannot sign, and
 * returning its address would produce trades that are born unsettleable.
 */
async function readSettlementWallet(env: Env, scope: Scope): Promise<DvpSettlementWallet | null> {
  const row = await getDb(env)
    .prepare(
      `SELECT w.id AS custody_wallet_id, w.public_key
         FROM dvp_settlement_wallets s
         JOIN custody_wallets w ON w.id = s.custody_wallet_id
        WHERE s.project_id = ? AND s.organization_id = ? AND w.status = 'active'`
    )
    .bind(scope.projectId, scope.organizationId)
    .first<{ custody_wallet_id: string; public_key: string }>();

  return row ? { custodyWalletId: row.custody_wallet_id, address: row.public_key } : null;
}
