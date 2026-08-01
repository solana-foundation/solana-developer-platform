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
  getTransferById(
    scope: PrivateChannelTransferProjectScope & { id: string }
  ): Promise<PrivateChannelTransferRow | null>;
  listTransfersByProject(
    input: ListPrivateChannelTransfersInput
  ): Promise<PrivateChannelTransferRow[]>;
  /** Other members and their verified wallets in an active channel/instance. */
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
