import type { PrivateChannelEventDisplayPayloadKey, PrivateChannelEventDto } from "@sdp/types";

export type PrivateChannelEventSummaryKind =
  | "deposit"
  | "withdrawal"
  | "transfer"
  | "wallet"
  | "channel"
  | "instance"
  | "member"
  | "lifecycle"
  | "error"
  | "unknown";

export interface PrivateChannelEventSummaryIds {
  depositId?: string;
  withdrawalId?: string;
  transferId?: string;
  walletId?: string;
  privateChannelUserId?: string;
  targetUserId?: string;
  membershipId?: string;
}

/**
 * Normalized, display-safe event data. Every value is a primitive string, so
 * list and detail views never need to coerce arbitrary payload values.
 */
export interface PrivateChannelEventSummary {
  kind: PrivateChannelEventSummaryKind;
  amount?: string;
  mint?: string;
  sender?: string;
  recipient?: string;
  pubkey?: string;
  signature?: string;
  gatewayUrl?: string;
  confirmedAt?: string;
  reason?: string;
  channelName?: string;
  latencyMs?: string;
  ids: PrivateChannelEventSummaryIds;
}

type EventSummaryInput = {
  family: PrivateChannelEventDto["family"] | string;
  type: PrivateChannelEventDto["type"] | string;
  payload: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(payload: Record<string, unknown> | null, key: string): string | undefined {
  const value = payload?.[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function readNumericDisplay(
  payload: Record<string, unknown> | null,
  key: string
): string | undefined {
  const stringValue = readString(payload, key);
  if (stringValue !== undefined) return stringValue;
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function resolveKind(family: string, type: string): PrivateChannelEventSummaryKind {
  if (type.startsWith("transfer.deposit.")) return "deposit";
  if (type.startsWith("transfer.withdrawal.")) return "withdrawal";
  if (type.startsWith("transfer.transfer.")) return "transfer";
  if (type.startsWith("member.wallet_")) return "wallet";
  if (type.startsWith("lifecycle.channel.")) return "channel";
  if (type.startsWith("lifecycle.instance.")) return "instance";
  if (family === "error" || type.startsWith("error.")) return "error";
  if (family === "transfer") return "transfer";
  if (family === "member") return "member";
  if (family === "lifecycle") return "lifecycle";
  return "unknown";
}

// `satisfies PrivateChannelEventDisplayPayloadKey[]` keeps these reads inside the
// server's display allowlist: a key the API strips would never arrive here.
const ID_KEYS = [
  "depositId",
  "withdrawalId",
  "transferId",
  "walletId",
  "privateChannelUserId",
  "targetUserId",
  "membershipId",
] as const satisfies readonly (keyof PrivateChannelEventSummaryIds &
  PrivateChannelEventDisplayPayloadKey)[];

const STRING_KEYS = [
  "amount",
  "mint",
  "sender",
  "recipient",
  "pubkey",
  "signature",
  "gatewayUrl",
  "confirmedAt",
] as const satisfies readonly (keyof PrivateChannelEventSummary &
  PrivateChannelEventDisplayPayloadKey)[];

/**
 * Extracts only known primitive fields from an event payload. API payloads are
 * untrusted at this boundary; malformed and future payloads return a useful
 * kind with whichever safe fields are present.
 */
export function summarizePrivateChannelEvent(event: EventSummaryInput): PrivateChannelEventSummary {
  const payload = asRecord(event.payload);
  const kind = resolveKind(event.family, event.type);
  const summary: PrivateChannelEventSummary = { kind, ids: {} };

  for (const key of ID_KEYS) {
    const value = readString(payload, key);
    if (value !== undefined) summary.ids[key] = value;
  }

  for (const key of STRING_KEYS) {
    const value = readString(payload, key);
    if (value !== undefined) summary[key] = value;
  }

  const reason =
    readString(payload, "failureReason") ??
    readString(payload, "reason") ??
    readString(payload, "message");
  if (reason !== undefined) summary.reason = reason;

  // Channel events name the channel in `name`; error payloads reuse `name` for
  // the error class, so only read it for channel lifecycle.
  if (kind === "channel") {
    const channelName = readString(payload, "name");
    if (channelName !== undefined) summary.channelName = channelName;
  }

  const latencyMs = readNumericDisplay(payload, "latencyMs");
  if (latencyMs !== undefined) summary.latencyMs = latencyMs;

  return summary;
}
