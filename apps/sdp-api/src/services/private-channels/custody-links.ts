import { getDb } from "@/db/client";
import type { Env } from "@/types/env";

interface CustodyEvidence {
  custody_wallet_id: string | null;
  organization_id?: string;
  project_id?: string;
  wallet_id?: string;
  sender_wallet_id?: string;
  pubkey?: string;
  depositor?: string;
  owner?: string;
  sender?: string;
}

/** Prove a page's retained links without changing its saved financial evidence. */
export async function resolvePrivateChannelCustodyLinks<T extends CustodyEvidence>(
  env: Env,
  scope: { organizationId: string; projectId: string },
  rows: T[]
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const providerIds = rows.flatMap((row) => {
    const providerId = row.wallet_id ?? row.sender_wallet_id;
    return providerId ? [providerId] : [];
  });
  const pins = rows.flatMap((row) => (row.custody_wallet_id ? [row.custody_wallet_id] : []));
  if (pins.length === 0 && providerIds.length === 0) {
    return rows.map((row) => ({ ...row, custody_wallet_id: null }));
  }
  const candidates = await getDb(env).queryMany<{
    id: string;
    wallet_id: string;
    public_key: string;
  }>(
    `SELECT w.id, w.wallet_id, w.public_key
       FROM custody_wallets w
       LEFT JOIN custody_configs cfg ON cfg.id = w.custody_config_id
       LEFT JOIN custody_connections conn ON conn.id = w.custody_connection_id
      WHERE (w.id = ANY(?::text[]) OR w.wallet_id = ANY(?::text[]))
        AND ((cfg.organization_id = ? AND cfg.project_id = ?)
          OR (conn.organization_id = ? AND conn.project_id = ?))`,
    [
      pins,
      providerIds,
      scope.organizationId,
      scope.projectId,
      scope.organizationId,
      scope.projectId,
    ]
  );
  type Candidate = (typeof candidates)[number];
  const byId = new Map<string, Candidate>();
  const byProviderAndAddress = new Map<string, Candidate | null>();
  for (const wallet of candidates) {
    byId.set(wallet.id, wallet);
    const key = JSON.stringify([wallet.wallet_id, wallet.public_key]);
    byProviderAndAddress.set(key, byProviderAndAddress.has(key) ? null : wallet);
  }
  return rows.map((row) => {
    const providerId = row.wallet_id ?? row.sender_wallet_id;
    const address = row.pubkey ?? row.depositor ?? row.owner ?? row.sender;
    const inScope =
      (row.organization_id === undefined || row.organization_id === scope.organizationId) &&
      (row.project_id === undefined || row.project_id === scope.projectId);
    const wallet =
      row.custody_wallet_id != null
        ? byId.get(row.custody_wallet_id)
        : byProviderAndAddress.get(JSON.stringify([providerId, address]));
    const matches =
      wallet != null &&
      inScope &&
      wallet.public_key === address &&
      (providerId === undefined || wallet.wallet_id === providerId);
    return { ...row, custody_wallet_id: matches ? wallet.id : null };
  });
}
