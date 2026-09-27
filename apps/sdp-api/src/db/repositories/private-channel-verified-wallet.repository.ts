export function generatePrivateChannelVerifiedWalletId(): string {
  return `pcvw_${crypto.randomUUID()}`;
}

/** A verified-wallet row: pubkey ↔ (project, SPC user), recorded after SPC verify-wallet. */
export interface PrivateChannelVerifiedWalletRow {
  id: string;
  organization_id: string;
  project_id: string;
  /** The private_channel_users compatibility row (SPC identity) for this wallet. */
  user_id: string;
  instance_id: string;
  wallet_id: string;
  pubkey: string;
  verified_at: string;
  created_at: string;
  updated_at: string;
}

export interface PrivateChannelWalletRevocationRow {
  id: string;
  organization_id: string;
  project_id: string;
  user_id: string;
  instance_id: string;
  wallet_id: string;
  pubkey: string;
  created_at: string;
  updated_at: string;
}

/** Project tenancy scope for verified-wallet lookups. */
export interface VerifiedWalletScope {
  organizationId: string;
  projectId: string;
}

export interface UpsertVerifiedWalletInput extends VerifiedWalletScope {
  userId: string;
  instanceId: string;
  walletId: string;
  pubkey: string;
}

/**
 * A mirror upsert that refuses to land when a revocation committed after the
 * caller observed `expectedRevocationEpoch`. The revocation epoch is the
 * barrier that keeps an in-flight verification from resurrecting a mirror that
 * a completed revocation removed (SOLA9-664).
 */
export interface ConditionalUpsertVerifiedWalletInput extends UpsertVerifiedWalletInput {
  expectedRevocationEpoch: number;
}

/** Input for the atomic local half of a wallet revocation. */
export interface RevokeVerifiedWalletInput extends VerifiedWalletScope {
  userId: string;
  instanceId: string;
  pubkey: string;
}

export interface PrivateChannelVerifiedWalletRepository {
  /**
   * Idempotently record an identity's verified wallet. A re-verify of the same
   * (user_id, instance_id, pubkey) refreshes the row; a member may verify many
   * wallets per instance. Call this ONLY from the wallets domain
   * module's verify logic (services/private-channels/wallets.ts) — that flow is
   * the single writer of private_channel_verified_wallets, after a successful
   * SPC verify.
   *
   * The write is conditional on the revocation epoch (see
   * `getRevocationEpoch`): when a revocation committed after the caller
   * observed `expectedRevocationEpoch`, the mirror is not written and this
   * rejects, so a stale verification continuation can never resurrect a mirror
   * that a completed revocation removed. The check is not a plain read: the
   * upsert creates the epoch row if absent and takes its row lock for the rest
   * of the transaction, so a revocation that overlaps this write either
   * commits before the locked epoch read (the write is refused) or blocks
   * until the write commits and removes the mirror afterwards — the mirror can
   * never outlive a revocation it overlaps.
   */
  upsert(input: ConditionalUpsertVerifiedWalletInput): Promise<PrivateChannelVerifiedWalletRow>;
  /**
   * The durable revocation epoch for one (instance, pubkey): 0 when the wallet
   * was never revoked, otherwise a count of committed revocations. Read it
   * BEFORE the SPC verify handshake and pass it to `upsert` as
   * `expectedRevocationEpoch`.
   */
  getRevocationEpoch(instanceId: string, pubkey: string): Promise<number>;
  /**
   * The local half of a revocation, atomically: advance the revocation epoch
   * for (instance_id, pubkey), remove the verified-wallet mirror keyed on the
   * unique (user_id, instance_id, pubkey), and remove the pending-revocation
   * retry marker. A pubkey verified under another instance (or by another
   * identity) is untouched. The epoch advance is the barrier an in-flight
   * verification's conditional upsert compares against, so it must commit
   * together with the mirror removal. Returns true if a mirror row or retry
   * marker was removed. Single-writer contract as for upsert.
   */
  revokeVerifiedWallet(input: RevokeVerifiedWalletInput): Promise<boolean>;
  /**
   * Persist an upstream binding that must be revoked even though its identity
   * became disabled before the normal mirror write. Disable retries enumerate
   * this row, so a failed compensating SPC delete remains recoverable.
   */
  recordPendingRevocation(
    input: UpsertVerifiedWalletInput
  ): Promise<PrivateChannelWalletRevocationRow>;
  /** Pending upstream revocations for one identity and instance. */
  listPendingRevocations(
    userId: string,
    instanceId: string
  ): Promise<PrivateChannelWalletRevocationRow[]>;
  /** Find the principal that owns a pubkey in one tenant-scoped SPC instance. */
  findByInstanceAndPubkey(
    scope: VerifiedWalletScope,
    instanceId: string,
    pubkey: string
  ): Promise<PrivateChannelVerifiedWalletRow | null>;
  /** The identity's verified wallets for one instance, newest first. */
  listByUserAndInstance(
    userId: string,
    instanceId: string
  ): Promise<PrivateChannelVerifiedWalletRow[]>;
  /**
   * Any member's verification of `pubkey` on `instanceId`, newest first, or
   * null. Answers "can this address ever spend a channel balance" — which is
   * what a deposit recipient has to satisfy — without naming a member.
   */
  findAnyByInstanceAndPubkey(
    instanceId: string,
    pubkey: string
  ): Promise<PrivateChannelVerifiedWalletRow | null>;
}

export function mapPrivateChannelVerifiedWalletRow(
  row: Record<string, unknown>
): PrivateChannelVerifiedWalletRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    user_id: row.user_id as string,
    instance_id: row.instance_id as string,
    wallet_id: row.wallet_id as string,
    pubkey: row.pubkey as string,
    verified_at: row.verified_at as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function mapPrivateChannelWalletRevocationRow(
  row: Record<string, unknown>
): PrivateChannelWalletRevocationRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    user_id: row.user_id as string,
    instance_id: row.instance_id as string,
    wallet_id: row.wallet_id as string,
    pubkey: row.pubkey as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}
