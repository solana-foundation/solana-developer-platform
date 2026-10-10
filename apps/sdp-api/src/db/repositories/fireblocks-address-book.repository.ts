import type { FireblocksAddressEntry } from "@sdp/custody/provisioning";
import type { AppDb } from "@/db";

export interface FireblocksBookScope {
  organizationId: string;
  projectId: string;
  connectionId: string;
}
export interface FireblocksProposal {
  id: string;
  account_fingerprint: string;
  wallet_id: string | null;
  state: "creating_wallet" | "adding_address" | "submitted" | "unknown" | "failed";
}
export class FireblocksAddressBookRepository {
  constructor(private readonly db: AppDb) {}

  async connections(scope?: { organizationId: string; projectId: string }) {
    return this.db.queryMany<{
      connection_id: string;
      organization_id: string;
      project_id: string;
      wallet_id: string;
    }>(
      `SELECT c.id AS connection_id, c.organization_id, c.project_id, MIN(w.id) AS wallet_id
       FROM custody_connections c JOIN custody_wallets w ON w.custody_connection_id = c.id AND w.status = 'active'
       LEFT JOIN fireblocks_contact_sync s ON s.connection_id = c.id
       WHERE c.provider = 'fireblocks' AND c.status = 'active'
       AND c.project_id IS NOT NULL
       AND (s.lease_until IS NULL OR s.lease_until < ?)
       AND (s.synced_at IS NULL OR s.synced_at < ?)
       ${scope ? "AND c.organization_id = ? AND c.project_id = ?" : ""}
       GROUP BY c.id, c.organization_id, c.project_id, s.synced_at, s.lease_until
       ORDER BY COALESCE(s.lease_until, s.synced_at, ''), c.id LIMIT ${scope ? 3 : 50}`,
      [
        new Date().toISOString(),
        new Date(Date.now() - 300_000).toISOString(),
        ...(scope ? [scope.organizationId, scope.projectId] : []),
      ]
    );
  }
  async claimSync(scope: FireblocksBookScope): Promise<string | null> {
    const lease = crypto.randomUUID();
    const now = new Date().toISOString();
    const row = await this.db.queryOne<{ lease_id: string }>(
      `INSERT INTO fireblocks_contact_sync (connection_id, organization_id, project_id, lease_id, lease_until)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (connection_id) DO UPDATE
       SET lease_id = EXCLUDED.lease_id, lease_until = EXCLUDED.lease_until
       WHERE fireblocks_contact_sync.organization_id = EXCLUDED.organization_id
       AND fireblocks_contact_sync.project_id = EXCLUDED.project_id
       AND (fireblocks_contact_sync.lease_until IS NULL OR fireblocks_contact_sync.lease_until < ?)
       AND (fireblocks_contact_sync.synced_at IS NULL OR fireblocks_contact_sync.synced_at < ?)
       RETURNING lease_id`,
      [
        scope.connectionId,
        scope.organizationId,
        scope.projectId,
        lease,
        new Date(Date.now() + 60_000).toISOString(),
        now,
        new Date(Date.now() - 300_000).toISOString(),
      ]
    );
    return row?.lease_id ?? null;
  }
  /** Serialize project imports so duplicate addresses from different connections stay linked. */
  async importContacts(
    scope: FireblocksBookScope,
    lease: string,
    entries: FireblocksAddressEntry[]
  ) {
    return this.db.transaction(async (tx) => {
      const project = await tx.queryOne(
        `SELECT id FROM projects WHERE id = ? AND organization_id = ? FOR UPDATE`,
        [scope.projectId, scope.organizationId]
      );
      if (!project) return;
      const claim = await tx.queryOne(
        `SELECT connection_id FROM fireblocks_contact_sync WHERE connection_id = ? AND organization_id = ? AND project_id = ? AND lease_id = ? FOR UPDATE`,
        [scope.connectionId, scope.organizationId, scope.projectId, lease]
      );
      if (!claim) return;
      for (const entry of entries) {
        const identity = [
          scope.connectionId,
          scope.organizationId,
          scope.projectId,
          entry.walletType,
          entry.walletId,
          entry.assetId,
          entry.address,
        ];
        const link = await tx.queryOne<{
          account_id: string;
          managed: boolean;
          imported_name: string;
        }>(
          `SELECT account_id, managed, imported_name FROM fireblocks_contact_links WHERE connection_id = ? AND organization_id = ? AND project_id = ? AND wallet_type = ? AND wallet_id = ? AND asset_id = ? AND address = ?`,
          identity
        );
        const name = entry.name.trim() || "Fireblocks wallet";
        if (link) {
          // Never overwrite user edits, revive archives, or redirect an existing address.
          if (link.managed) {
            await tx.execute(
              `UPDATE counterparties c SET display_name = ?, updated_at = sdp_iso_now()
              FROM counterparty_accounts a WHERE a.id = ? AND a.counterparty_id = c.id AND c.organization_id = ? AND c.project_id = ?
              AND c.status = 'active' AND a.status = 'active' AND c.display_name = ?`,
              [name, link.account_id, scope.organizationId, scope.projectId, link.imported_name]
            );
            await tx.execute(
              `UPDATE counterparty_accounts SET label = ?, updated_at = sdp_iso_now() WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'active' AND label = ?`,
              [name, link.account_id, scope.organizationId, scope.projectId, link.imported_name]
            );
          }
          await tx.execute(
            `UPDATE fireblocks_contact_links SET remote_status = ?, imported_name = ?, seen_at = sdp_iso_now() WHERE connection_id = ? AND organization_id = ? AND project_id = ? AND wallet_type = ? AND wallet_id = ? AND asset_id = ? AND address = ?`,
            [entry.status, name, ...identity]
          );
          continue;
        }
        // Import approved entries only. Include archived accounts in deduplication so user archives stick.
        if (entry.status !== "APPROVED") continue;
        let account = await tx.queryOne<{ id: string }>(
          `SELECT a.id FROM counterparty_accounts a JOIN counterparties c ON c.id = a.counterparty_id
          WHERE a.organization_id = ? AND a.project_id = ? AND a.account_kind = 'crypto_wallet' AND a.network = 'solana' AND a.address = ?
          ORDER BY a.created_at, a.id LIMIT 1`,
          [scope.organizationId, scope.projectId, entry.address]
        );
        let managed = false;
        if (!account) {
          const contactId = `cpty_${crypto.randomUUID()}`;
          const accountId = `counterparty_account_${crypto.randomUUID()}`;
          await tx.execute(
            `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name, status, provider_data)
            VALUES (?, ?, ?, 'business', ?, 'active', '{}'::jsonb)`,
            [contactId, scope.organizationId, scope.projectId, name]
          );
          await tx.execute(
            `INSERT INTO counterparty_accounts (id, organization_id, project_id, counterparty_id, account_kind, label, details, provider_account_data, network, address)
            VALUES (?, ?, ?, ?, 'crypto_wallet', ?, ?::jsonb, '{}'::jsonb, 'solana', ?)`,
            [
              accountId,
              scope.organizationId,
              scope.projectId,
              contactId,
              name,
              JSON.stringify({ network: "solana", address: entry.address }),
              entry.address,
            ]
          );
          account = { id: accountId };
          managed = true;
        }
        await tx.execute(
          `INSERT INTO fireblocks_contact_links
          (connection_id, organization_id, project_id, wallet_type, wallet_id, asset_id, address, account_id, managed, imported_name, remote_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          [...identity, account.id, managed, name, entry.status]
        );
      }
      await tx.execute(
        `UPDATE fireblocks_contact_sync SET synced_at = sdp_iso_now(), lease_until = NULL, lease_id = NULL WHERE connection_id = ? AND organization_id = ? AND project_id = ? AND lease_id = ?`,
        [scope.connectionId, scope.organizationId, scope.projectId, lease]
      );
    });
  }
  async proposal(scope: FireblocksBookScope, assetId: string, address: string) {
    return this.db.queryOne<FireblocksProposal>(
      `SELECT id, account_fingerprint, wallet_id, state FROM fireblocks_whitelist_proposals WHERE connection_id = ? AND organization_id = ? AND project_id = ? AND asset_id = ? AND address = ?`,
      [scope.connectionId, scope.organizationId, scope.projectId, assetId, address]
    );
  }
  async claimProposal(
    scope: FireblocksBookScope,
    fingerprint: string,
    assetId: string,
    address: string
  ) {
    return this.db.queryOne<FireblocksProposal>(
      `INSERT INTO fireblocks_whitelist_proposals (id, connection_id, organization_id, project_id, account_fingerprint, asset_id, address, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'creating_wallet') ON CONFLICT (connection_id, asset_id, address) DO UPDATE
      SET id = EXCLUDED.id, state = 'creating_wallet', updated_at = sdp_iso_now()
      WHERE fireblocks_whitelist_proposals.state = 'failed'
      AND fireblocks_whitelist_proposals.organization_id = EXCLUDED.organization_id
      AND fireblocks_whitelist_proposals.project_id = EXCLUDED.project_id
      AND fireblocks_whitelist_proposals.account_fingerprint = EXCLUDED.account_fingerprint
      RETURNING id, account_fingerprint, wallet_id, state`,
      [
        `fbwl_${crypto.randomUUID()}`,
        scope.connectionId,
        scope.organizationId,
        scope.projectId,
        fingerprint,
        assetId,
        address,
      ]
    );
  }
  async updateProposal(
    scope: FireblocksBookScope,
    id: string,
    state: FireblocksProposal["state"],
    walletId?: string
  ) {
    await this.db.execute(
      `UPDATE fireblocks_whitelist_proposals SET state = ?, wallet_id = COALESCE(?, wallet_id), updated_at = sdp_iso_now() WHERE id = ? AND connection_id = ? AND organization_id = ? AND project_id = ?`,
      [state, walletId ?? null, id, scope.connectionId, scope.organizationId, scope.projectId]
    );
  }
}
