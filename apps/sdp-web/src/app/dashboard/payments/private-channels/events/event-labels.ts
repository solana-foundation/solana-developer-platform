import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  PRIVATE_CHANNEL_EVENT_TYPES,
  type PrivateChannelEventFamily,
  type PrivateChannelEventStatus,
} from "@sdp/types";
import type { BadgeVariant } from "@/components/ui/badge";
import type { MessageKey } from "@/i18n/messages";

/**
 * Translation keys for the event enums.
 *
 * The feed previously rendered the wire values directly, so operators read rows
 * like "lifecycle.instance.connected". Unknown values fall back to a
 * de-dotted/de-underscored form of the raw string rather than rendering blank,
 * so an event type added API-side still reads sensibly before this map catches up.
 */
const EVENT_TYPE_KEYS: Record<string, MessageKey> = {
  [PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED]:
    "DashboardPrivateChannels.events.typeInstanceConnected",
  [PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_DISCONNECTED]:
    "DashboardPrivateChannels.events.typeInstanceDisconnected",
  [PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED]:
    "DashboardPrivateChannels.events.typeChannelCreated",
  [PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_ARCHIVED]:
    "DashboardPrivateChannels.events.typeChannelArchived",
  [PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_ADDED]: "DashboardPrivateChannels.events.typeMemberAdded",
  [PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_REVOKED]: "DashboardPrivateChannels.events.typeMemberRevoked",
  [PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_ROLE_CHANGED]:
    "DashboardPrivateChannels.events.typeMemberRoleChanged",
  [PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_CHALLENGE_REQUESTED]:
    "DashboardPrivateChannels.events.typeWalletChallengeRequested",
  [PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFIED]:
    "DashboardPrivateChannels.events.typeWalletVerified",
  [PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFICATION_REVOKED]:
    "DashboardPrivateChannels.events.typeWalletVerificationRevoked",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_DEPOSIT_SUBMITTED]:
    "DashboardPrivateChannels.events.typeDepositSubmitted",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_DEPOSIT_CONFIRMED]:
    "DashboardPrivateChannels.events.typeDepositConfirmed",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_DEPOSIT_SETTLED]:
    "DashboardPrivateChannels.events.typeDepositSettled",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_DEPOSIT_FAILED]:
    "DashboardPrivateChannels.events.typeDepositFailed",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_SUBMITTED]:
    "DashboardPrivateChannels.events.typeWithdrawalSubmitted",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_CONFIRMED]:
    "DashboardPrivateChannels.events.typeWithdrawalConfirmed",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_SETTLED]:
    "DashboardPrivateChannels.events.typeWithdrawalSettled",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_FAILED]:
    "DashboardPrivateChannels.events.typeWithdrawalFailed",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_SUBMITTED]:
    "DashboardPrivateChannels.events.typeTransferSubmitted",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_CONFIRMED]:
    "DashboardPrivateChannels.events.typeTransferConfirmed",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_FAILED]:
    "DashboardPrivateChannels.events.typeTransferFailed",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_DEPOSIT_AWAITING_SPC_CREDIT]:
    "DashboardPrivateChannels.events.typeDepositAwaitingSpcCredit",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_RELEASE_ATTEMPT_FAILED]:
    "DashboardPrivateChannels.events.typeWithdrawalReleaseAttemptFailed",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_STUCK_WARNING]:
    "DashboardPrivateChannels.events.typeStuckWarning",
  [PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_NEEDS_MANUAL_REVIEW]:
    "DashboardPrivateChannels.events.typeNeedsManualReview",
  [PRIVATE_CHANNEL_EVENT_TYPES.ERROR_SPC_UNREACHABLE]:
    "DashboardPrivateChannels.events.typeSpcUnreachable",
};

const EVENT_FAMILY_KEYS: Record<PrivateChannelEventFamily, MessageKey> = {
  [PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE]: "DashboardPrivateChannels.events.familyLifecycle",
  [PRIVATE_CHANNEL_EVENT_FAMILIES.MEMBER]: "DashboardPrivateChannels.events.familyMember",
  [PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER]: "DashboardPrivateChannels.events.familyTransfer",
  [PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR]: "DashboardPrivateChannels.events.familyError",
};

const EVENT_STATUS_KEYS: Record<PrivateChannelEventStatus, MessageKey> = {
  [PRIVATE_CHANNEL_EVENT_STATUSES.PENDING]: "DashboardPrivateChannels.events.statusPending",
  [PRIVATE_CHANNEL_EVENT_STATUSES.CONFIRMED]: "DashboardPrivateChannels.events.statusConfirmed",
  [PRIVATE_CHANNEL_EVENT_STATUSES.FAILED]: "DashboardPrivateChannels.events.statusFailed",
  [PRIVATE_CHANNEL_EVENT_STATUSES.STALE]: "DashboardPrivateChannels.events.statusStale",
  [PRIVATE_CHANNEL_EVENT_STATUSES.INFO]: "DashboardPrivateChannels.events.statusInfo",
};

export const EVENT_FAMILY_BADGE: Record<PrivateChannelEventFamily, BadgeVariant> = {
  [PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE]: "info",
  [PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR]: "danger",
  [PRIVATE_CHANNEL_EVENT_FAMILIES.MEMBER]: "default",
  [PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER]: "success",
};

export const EVENT_STATUS_BADGE: Record<PrivateChannelEventStatus, BadgeVariant> = {
  [PRIVATE_CHANNEL_EVENT_STATUSES.PENDING]: "warning",
  [PRIVATE_CHANNEL_EVENT_STATUSES.CONFIRMED]: "success",
  [PRIVATE_CHANNEL_EVENT_STATUSES.FAILED]: "danger",
  [PRIVATE_CHANNEL_EVENT_STATUSES.STALE]: "warning",
  [PRIVATE_CHANNEL_EVENT_STATUSES.INFO]: "default",
};

type Translate = (key: MessageKey) => string;

/** `transfer.deposit.settled` → `Transfer deposit settled`. */
function humanizeRawEventValue(value: string): string {
  const words = value.replace(/[._]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function eventTypeLabel(t: Translate, type: string): string {
  const key = EVENT_TYPE_KEYS[type];
  return key ? t(key) : humanizeRawEventValue(type);
}

export function eventFamilyLabel(t: Translate, family: PrivateChannelEventFamily): string {
  const key = EVENT_FAMILY_KEYS[family];
  return key ? t(key) : humanizeRawEventValue(family);
}

export function eventStatusLabel(t: Translate, status: PrivateChannelEventStatus): string {
  const key = EVENT_STATUS_KEYS[status];
  return key ? t(key) : humanizeRawEventValue(status);
}
