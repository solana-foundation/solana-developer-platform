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

import type { CustodyWalletOwnerTarget, SdpEnvironment } from "@sdp/types";
import { type Address, address } from "@solana/kit";
import type { Context } from "hono";
import { getDb } from "@/db";
import { conflict, notFound } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { provisionApiKeyWallet } from "@/services/api-key-wallet-provisioning.service";
import type { Env } from "@/types/env";

/** Shown in the custody wallet list so this wallet is not a mystery row. */
const SETTLEMENT_WALLET_LABEL = "DvP settlement authority";

const DVP_SETTLEMENT_PRIVY_UNAVAILABLE_REASON = "dvp_settlement_privy_unavailable";

export interface DvpSettlementWallet {
  /** `custody_wallets.id` — what the signer resolver takes. */
  custodyWalletId: string;
  /** The on-chain address, which is what the PDA seeds use. */
  address: Address;
  /** `custody_wallets.wallet_id` — the custody provider's wallet identifier. */
  providerWalletId: string;
}

interface Scope {
  organizationId: string;
  projectId: string;
}

/**
 * Returns the project's settlement wallet, provisioning one on first use.
 *
 * The new wallet is a Privy wallet under the backend {@link resolveDvpSettlementOwner}
 * picks, decided from database reads before any provider call.
 *
 * Safe to call concurrently. Two racing trade creations both pick the same
 * backend and both mint a provider wallet — that part cannot be made atomic,
 * because it is a call out to the custody provider — but only one wins the
 * insert, and the loser returns the winner's wallet. The loser's wallet is left
 * orphaned and logged rather than deleted: it holds no funds, and deleting a
 * freshly provisioned key on a race is a worse failure mode than leaving an
 * unused one behind.
 *
 * @param env - API process environment.
 * @param auditContext - Authenticated initiating request for wallet creation audit.
 * @param scope - Organization and project the trade belongs to.
 * @returns The settlement wallet's record id and address.
 */
export async function getOrCreateDvpSettlementWallet(
  env: Env,
  auditContext: Context<{ Bindings: Env }>,
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

  const owner = await resolveDvpSettlementOwner(env, scope);
  const provisioned = await provisionApiKeyWallet(getDb(env), env, {
    auditContext,
    creationReason: "dvp_settlement_authority",
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    owner,
    label: SETTLEMENT_WALLET_LABEL,
    // Marked so the wallets list treats it as privileged rather than a transfer wallet.
    purpose: "dvp_settlement_authority",
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

/**
 * Picks the Privy backend a new settlement wallet is created under:
 *
 * - Sandbox with an active Managed Privy config: the Managed config, however many
 *   active Privy BYOK connections the project also has.
 * - Sandbox without one, and every Production project (Managed config ignored):
 *   exactly one active Privy BYOK connection is used; zero, or more than one, is
 *   refused with 409 `dvp_settlement_privy_unavailable`.
 *
 * The more-than-one-connection 409 therefore applies only where no Managed config
 * is taken.
 *
 * Decided from database reads alone and writes nothing, so a refusal precedes
 * every provider call. A connection that stops being usable after this choice is
 * refused by the connection wallet path's own runtime check, not re-checked here.
 *
 * @param env - API process environment.
 * @param scope - Organization and project the trade belongs to.
 * @returns The connection or Managed provider the settlement wallet lives under.
 * @throws 404 when the project is not in the organization.
 * @throws 409 when no Managed config is taken and the project has zero or more than one active Privy connection.
 */
export async function resolveDvpSettlementOwner(
  env: Env,
  scope: Scope
): Promise<CustodyWalletOwnerTarget> {
  const db = getDb(env);
  const [project, connections] = await Promise.all([
    db
      .prepare(
        `SELECT p.environment,
                EXISTS (
                  SELECT 1 FROM custody_configs cfg
                   WHERE cfg.organization_id = p.organization_id
                     AND cfg.project_id = p.id
                     AND cfg.provider = 'privy'
                     AND cfg.status = 'active'
                ) AS has_managed_privy
           FROM projects p
          WHERE p.id = ? AND p.organization_id = ?`
      )
      .bind(scope.projectId, scope.organizationId)
      .first<{ environment: SdpEnvironment; has_managed_privy: boolean }>(),
    db
      .prepare(
        `SELECT id
           FROM custody_connections
          WHERE organization_id = ?
            AND project_id = ?
            AND provider = 'privy'
            AND status = 'active'
          ORDER BY id`
      )
      .bind(scope.organizationId, scope.projectId)
      .all<{ id: string }>(),
  ]);
  if (!project) {
    throw notFound("Project");
  }

  const connectionIds = connections.results.map((connection) => connection.id);
  switch (project.environment) {
    case "production":
      return singlePrivyConnection(scope, project.environment, connectionIds);
    case "sandbox":
      return project.has_managed_privy
        ? { provider: "privy" }
        : singlePrivyConnection(scope, project.environment, connectionIds);
    default: {
      const unhandled: never = project.environment;
      throw new Error(`Unknown project environment: ${String(unhandled)}`);
    }
  }
}

/**
 * The project's one active Privy connection as a settlement owner, refusing none or several.
 *
 * @param scope - Organization and project the trade belongs to.
 * @param environment - The project's environment, for the refusal log.
 * @param connectionIds - The project's active Privy connection IDs.
 * @returns The single connection as a wallet owner.
 * @throws 409 when the project has zero or several active Privy connections.
 */
function singlePrivyConnection(
  scope: Scope,
  environment: SdpEnvironment,
  connectionIds: string[]
): CustodyWalletOwnerTarget {
  if (connectionIds.length === 1) {
    return { connectionId: connectionIds[0] };
  }
  getLogger().warn(
    {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environment,
      activePrivyConnectionCount: connectionIds.length,
      reason: DVP_SETTLEMENT_PRIVY_UNAVAILABLE_REASON,
    },
    "dvp_settlement_owner_unavailable"
  );
  throw conflict(
    connectionIds.length === 0
      ? "DvP settlement needs a Privy custody backend for this project"
      : "DvP settlement needs exactly one active Privy connection for this project",
    { reason: DVP_SETTLEMENT_PRIVY_UNAVAILABLE_REASON }
  );
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
/**
 * The project's settlement wallet, or null when it has none yet.
 *
 * Exported for surfaces that need to REPORT on the authority without causing
 * one to exist: reading a trade must not provision a wallet as a side effect.
 */
export async function readDvpSettlementWallet(
  env: Env,
  scope: Scope
): Promise<DvpSettlementWallet | null> {
  return readSettlementWallet(env, scope);
}

async function readSettlementWallet(env: Env, scope: Scope): Promise<DvpSettlementWallet | null> {
  const row = await getDb(env)
    .prepare(
      `SELECT w.id AS custody_wallet_id, w.public_key, w.wallet_id
         FROM dvp_settlement_wallets s
         JOIN custody_wallets w ON w.id = s.custody_wallet_id
        WHERE s.project_id = ? AND s.organization_id = ? AND w.status = 'active'`
    )
    .bind(scope.projectId, scope.organizationId)
    .first<{ custody_wallet_id: string; public_key: string; wallet_id: string }>();

  return row
    ? {
        custodyWalletId: row.custody_wallet_id,
        address: address(row.public_key),
        providerWalletId: row.wallet_id,
      }
    : null;
}
