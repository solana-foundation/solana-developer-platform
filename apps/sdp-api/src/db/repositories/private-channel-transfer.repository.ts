import type {
  PrivateChannelMemberTransferStatus,
  PrivateChannelTransfer,
  PrivateChannelTransferRecipientDto,
} from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export function generatePrivateChannelTransferId(): string {
  return `pct_${crypto.randomUUID()}`;
}

/** Upper bound on an unpaginated history read. */
export const DEFAULT_TRANSFER_LIST_LIMIT = 200;

export interface PrivateChannelTransferRow {
  id: string;
  organization_id: string;
  project_id: string;
  instance_id: string;
  channel_id: string;
  sender_private_channel_user_id: string;
  recipient_private_channel_user_id: string;
  sender_wallet_id: string;
  recipient_verified_wallet_id: string;
  sender: string;
  recipient: string;
  mint: string;
  amount: string;
  status: PrivateChannelMemberTransferStatus;
  signature: string | null;
  failure_reason: string | null;
  /** The caller's `Idempotency-Key`; the tenant-scoped reservation this row claimed. */
  idempotency_key: string | null;
  /** Fingerprint of the request that claimed the key. Null only on pre-header history. */
  idempotency_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

export interface PrivateChannelTransferProjectScope {
  organizationId: string;
  projectId: string;
}

/** Always inserted as `pending`; later states arrive via `updateTransfer`. */
export interface CreatePrivateChannelTransferInput extends PrivateChannelTransferProjectScope {
  instanceId: string;
  channelId: string;
  senderPrivateChannelUserId: string;
  recipientPrivateChannelUserId: string;
  senderWalletId: string;
  recipientVerifiedWalletId: string;
  sender: string;
  recipient: string;
  mint: string;
  amount: string;
  /**
   * The reservation. Both fields travel together — the schema rejects one
   * without the other — because a key with no fingerprint could only ever be
   * replayed blind.
   */
  idempotencyKey: string;
  idempotencyFingerprint: string;
}

export interface UpdatePrivateChannelTransferInput {
  id: string;
  status: PrivateChannelMemberTransferStatus;
  /** Set on submit; kept when omitted (so the confirm update preserves it). */
  signature?: string | null;
  /** Set on failure; kept when omitted. */
  failureReason?: string | null;
  /**
   * Compare-and-swap guard: when set, the update only applies if the row is
   * still in this status, so a late confirm cannot overwrite a terminal state.
   */
  expectedStatus?: PrivateChannelMemberTransferStatus;
  /**
   * Additionally require that no signature has been persisted yet. Guards the
   * fail path of abandoned-reservation recovery: a decision made from a
   * signatureless snapshot must not land on a row a live request signed in the
   * meantime.
   */
  expectedSignatureAbsent?: boolean;
}

export interface ListPrivateChannelTransfersInput extends PrivateChannelTransferProjectScope {
  channelId?: string;
  /** Caps the history page; defaults to `DEFAULT_TRANSFER_LIST_LIMIT`. */
  limit?: number;
}

export interface ListEligiblePrivateChannelTransferRecipientsInput
  extends PrivateChannelTransferProjectScope {
  instanceId: string;
  channelId: string;
  /** Marks results as `isSelf` and sorts them first; never excludes them. */
  initiatingPrivateChannelUserId: string;
}

export interface PrivateChannelTransferRepositoryContext {
  db: RepositoryDbClient;
}

export interface PrivateChannelTransferRepository {
  createTransfer(
    input: CreatePrivateChannelTransferInput
  ): Promise<PrivateChannelTransferRow | null>;
  updateTransfer(
    input: UpdatePrivateChannelTransferInput
  ): Promise<PrivateChannelTransferRow | null>;
  /**
   * The row that already claimed `idempotencyKey` in this tenant, or null.
   * Scoped to (organization, project) to match the unique index, so one
   * tenant's key can neither collide with nor probe for another's.
   */
  findTransferByIdempotency(
    scope: PrivateChannelTransferProjectScope & { idempotencyKey: string }
  ): Promise<PrivateChannelTransferRow | null>;
  getTransferById(
    scope: PrivateChannelTransferProjectScope & { id: string }
  ): Promise<PrivateChannelTransferRow | null>;
  listTransfersByProject(
    input: ListPrivateChannelTransfersInput
  ): Promise<PrivateChannelTransferRow[]>;
  /**
   * Every verified wallet on an active channel/instance, one entry per wallet,
   * including the initiating member's own. Wallet-level self-sends are rejected
   * at the access layer, not filtered out here.
   */
  listEligibleRecipients(
    input: ListEligiblePrivateChannelTransferRecipientsInput
  ): Promise<PrivateChannelTransferRecipientDto[]>;
}

export function mapPrivateChannelTransferRow(
  row: PrivateChannelTransferRow
): PrivateChannelTransfer {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    instanceId: row.instance_id,
    channelId: row.channel_id,
    walletId: row.sender_wallet_id,
    sender: row.sender,
    recipient: row.recipient,
    mint: row.mint,
    amount: row.amount,
    status: row.status,
    signature: row.signature ?? null,
    failureReason: row.failure_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
