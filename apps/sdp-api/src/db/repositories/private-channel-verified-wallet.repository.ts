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
  /**
   * The `updated_at` watermark returned by `claimStaleVerificationCleanup` for
   * the compensating delete of a stale verification. When set, the marker
   * clear only removes the marker while it still carries that watermark: a
   * stand-down that timed out re-owns the marker through
   * `recordPendingRevocation` (backdated, immediately takeover-able), and that
   * re-owned record must survive this clear — it documents a late binding this
   * delete never covered. A real delete (user request or principal disable)
   * leaves it unset and clears whatever marker is present: its own delete
   * covers the binding outright.
   */
  claimedMarkerUpdatedAt?: string;
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
   * Decide — under the revocation-epoch row lock — whether a stale
   * verification's compensating SPC delete may still run. Returns null when
   * a newer verification of the same identity has already re-created the
   * mirror: its upstream binding is the one the compensating delete would
   * remove, so the caller must stand down. Returns null as well when another
   * stale verification's cleanup for this binding is still pending (a fresh
   * retry marker): SPC keeps one binding per (SPC user, pubkey), so the
   * pending cleaner's single delete covers them all, and a second concurrent
   * delete would let the first finisher clear the shared latch while the
   * second delete is still in flight — a fresh verification landing in that
   * window would lose its binding and mirror to the outstanding delete. A
   * marker older than the cleanup lease (longer than any timeout-bounded
   * compensating delete) cannot have a delete in flight, so the claim takes
   * it over: that converges an owner that died mid-cleanup and the
   * undecided-cleanup fallback marker. Otherwise advances the epoch —
   * the same barrier a revocation uses, so any verification that has not
   * landed yet is refused — and records the pending-revocation retry marker
   * for the binding in the same transaction, so a failed or interrupted
   * compensation stays recoverable by the principal-disable cleanup that
   * enumerates these markers.
   *
   * On success returns the claimed marker's `updated_at` as an ownership
   * watermark: the compensating clear passes it back via
   * `revokeVerifiedWallet` so it only ever removes the marker it still owns.
   * A marker re-owned by a later fallback (see `recordPendingRevocation`)
   * carries a different watermark and survives this request's clear, keeping
   * the binding it documents discoverable. Single-writer contract as for
   * upsert.
   */
  claimStaleVerificationCleanup(input: UpsertVerifiedWalletInput): Promise<string | null>;
  /**
   * Whether a pending-revocation retry marker exists for this identity's
   * (user_id, instance_id, pubkey). A pending marker means a stale
   * verification's compensating SPC delete is still owed for this pubkey, so
   * the mirror upsert refuses to land while one exists (the marker is the
   * upsert's latch) — a refused verification can never hand a live binding to
   * that delete.
   */
  hasPendingRevocation(userId: string, instanceId: string, pubkey: string): Promise<boolean>;
  /**
   * The undecided-cleanup fallback: durably record the pending-revocation
   * retry marker WITHOUT advancing the epoch, so a late upstream binding stays
   * discoverable by the principal-disable cleanup even when
   * `claimStaleVerificationCleanup` itself failed and no compensating delete
   * can be decided. Under the revocation-epoch row lock, the record is skipped
   * (returning false) when a mirror that belongs to this identity already
   * exists: that mirror is a newer verification's, its binding must survive,
   * and a marker would latch the mirror upsert against a row that is already
   * there.
   *
   * When a marker already exists, the fallback re-owns it instead of skipping:
   * the marker's owner may be a cleanup claim whose compensating delete has
   * already returned while its watermark-scoped clear has not landed yet, and
   * that owner's clear would otherwise remove the shared row and orphan a
   * binding this request's own handshake created behind the delete's back —
   * no mirror and no marker for later cleanup to find. The re-own refreshes
   * `updated_at` (so the owner's clear misses it and claims keep standing
   * down while the owner's delete can still be in flight) and preserves the
   * owner's `claim_epoch`, so the latch drops as soon as that owner converges
   * and the next refused verification takes the cleanup over. A marker this
   * fallback creates is written already outside the cleanup lease (backdated
   * — no compensating delete is in flight for it), so it is takeover-able
   * right away. Single-writer contract as for upsert.
   */
  recordPendingRevocation(input: UpsertVerifiedWalletInput): Promise<boolean>;
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
