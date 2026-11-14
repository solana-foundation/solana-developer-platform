import type { DatabaseExecutor } from "@/db/client";
import { conflict, notFound } from "@/lib/errors";

export interface FireblocksProposalScope {
  organizationId: string;
  projectId: string;
}
export interface FireblocksSigningProposalRow {
  id: string;
  organization_id: string;
  project_id: string;
  custody_wallet_id: string;
  connection_id: string;
  account_fingerprint: string;
  vault_account_id: string;
  source_address: string;
  asset_id: string;
  operation: "RAW" | "PROGRAM_CALL";
  provider_transaction_id: string | null;
  status: string;
  cancel_requested_at: string | null;
  finished_at: string | null;
  created_at: string;
}

/** Every read and write is bound to the originating project, including cleanup. */
export class FireblocksProposalsRepository {
  constructor(
    private readonly db: DatabaseExecutor,
    private readonly scope: FireblocksProposalScope
  ) {}

  async create(input: {
    connectionId: string;
    walletId: string;
    accountFingerprint: string;
    sourceAddress: string;
    operation: "RAW" | "PROGRAM_CALL";
    assetId: string;
    requestId?: string;
  }): Promise<string> {
    const id = `fbp_${crypto.randomUUID()}`;
    const inserted = await this.db.queryOne<{ id: string }>(
      `INSERT INTO fireblocks_signing_proposals
       (id, organization_id, project_id, custody_wallet_id, connection_id, account_fingerprint,
        vault_account_id, source_address, asset_id, operation, request_id)
       SELECT ?, c.organization_id, c.project_id, w.id, c.id, ?, ?, ?, ?, ?, ?
       FROM custody_wallets w JOIN custody_connections c ON c.id = w.custody_connection_id
       WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ? AND w.wallet_id = ?
       RETURNING id`,
      [
        id,
        input.accountFingerprint,
        input.walletId.replace(/^fb_/, ""),
        input.sourceAddress,
        input.assetId,
        input.operation,
        input.requestId ?? null,
        input.connectionId,
        this.scope.organizationId,
        this.scope.projectId,
        input.walletId,
      ]
    );
    if (!inserted) throw conflict("Fireblocks proposal wallet is unavailable");
    return inserted.id;
  }

  get(id: string): Promise<FireblocksSigningProposalRow | null> {
    return this.db.queryOne<FireblocksSigningProposalRow>(
      `SELECT * FROM fireblocks_signing_proposals WHERE id = ? AND organization_id = ? AND project_id = ?`,
      [id, this.scope.organizationId, this.scope.projectId]
    );
  }

  async require(id: string): Promise<FireblocksSigningProposalRow> {
    const row = await this.get(id);
    if (!row) throw notFound("Fireblocks proposal");
    return row;
  }

  list(walletId: string, offset: number): Promise<FireblocksSigningProposalRow[]> {
    return this.db.queryMany<FireblocksSigningProposalRow>(
      `SELECT * FROM fireblocks_signing_proposals WHERE organization_id = ? AND project_id = ?
       AND custody_wallet_id = ? ORDER BY created_at DESC, id DESC LIMIT 21 OFFSET ?`,
      [this.scope.organizationId, this.scope.projectId, walletId, offset]
    );
  }

  /** Atomic with the cancellation claim: a cancellation that wins prevents signature delivery. */
  async observe(
    id: string,
    providerId: string,
    status: string,
    terminal: boolean
  ): Promise<boolean> {
    const row = await this.db.queryOne<{ cancel_requested_at: string | null; status: string }>(
      `UPDATE fireblocks_signing_proposals SET provider_transaction_id = ?, status = CASE WHEN finished_at IS NULL THEN ? ELSE status END,
       finished_at = CASE WHEN ?::boolean THEN COALESCE(finished_at, sdp_iso_now()) ELSE finished_at END,
       updated_at = sdp_iso_now()
       WHERE id = ? AND organization_id = ? AND project_id = ?
         AND (provider_transaction_id IS NULL OR provider_transaction_id = ?)
       RETURNING cancel_requested_at, status`,
      [
        providerId,
        status,
        terminal,
        id,
        this.scope.organizationId,
        this.scope.projectId,
        providerId,
      ]
    );
    if (!row) throw conflict("Fireblocks proposal identity changed");
    return row.cancel_requested_at === null && row.status === status;
  }

  /**
   * Close a proposal the provider never accepted: the create was refused or the lookup is
   * gone, so there is no provider transaction to reconcile. Guarded against rows a poll
   * already advanced to a provider transaction id.
   */
  async failUnaccepted(id: string): Promise<boolean> {
    return (
      (await this.db.queryOne<{ id: string }>(
        `UPDATE fireblocks_signing_proposals SET status = 'FAILED',
        finished_at = COALESCE(finished_at, sdp_iso_now()), updated_at = sdp_iso_now()
        WHERE id = ? AND organization_id = ? AND project_id = ?
          AND finished_at IS NULL AND provider_transaction_id IS NULL RETURNING id`,
        [id, this.scope.organizationId, this.scope.projectId]
      )) !== null
    );
  }

  async requestCancellation(id: string): Promise<boolean> {
    return (
      (await this.db.queryOne<{ id: string }>(
        `UPDATE fireblocks_signing_proposals SET cancel_requested_at = COALESCE(cancel_requested_at, sdp_iso_now()),
       updated_at = sdp_iso_now()
       WHERE id = ? AND organization_id = ? AND project_id = ? AND finished_at IS NULL RETURNING id`,
        [id, this.scope.organizationId, this.scope.projectId]
      )) !== null
    );
  }

  async claimPoll(id: string): Promise<boolean> {
    return (
      (await this.db.queryOne<{ id: string }>(
        `UPDATE fireblocks_signing_proposals SET last_polled_at = sdp_iso_now(), updated_at = sdp_iso_now()
       WHERE id = ? AND organization_id = ? AND project_id = ? AND finished_at IS NULL
         AND (last_polled_at IS NULL OR last_polled_at < ?)
       RETURNING id`,
        [
          id,
          this.scope.organizationId,
          this.scope.projectId,
          new Date(Date.now() - 15_000).toISOString(),
        ]
      )) !== null
    );
  }
}
