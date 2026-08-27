"use client";

import {
  PRIVATE_CHANNEL_EVENT_TYPES,
  type PrivateChannelEventDto,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn } from "@/lib/utils";
import {
  EVENT_FAMILY_BADGE,
  EVENT_STATUS_BADGE,
  eventFamilyLabel,
  eventStatusLabel,
  eventTypeLabel,
} from "./event-labels";
import { type EventNames, nameOf } from "./event-names";
import type { PrivateChannelEventSummary } from "./event-summary";

interface EventDetailProps {
  event: PrivateChannelEventDto;
  summary: PrivateChannelEventSummary;
  formattedOccurredAt: string;
  canViewRawPayload: boolean;
  names?: EventNames;
  onClose: () => void;
}

interface DetailField {
  key: string;
  label: string;
  value: string;
  breakAll?: boolean;
}

function detailField(
  key: string,
  label: string,
  value: string | null | undefined,
  breakAll = false
): DetailField | null {
  return value ? { key, label, value, breakAll } : null;
}

/**
 * A resolved name above its raw reference, so a row reads "Treasury" over
 * "pch_9f1c…" instead of hiding the id the user may need to copy. Emits only the
 * rows that exist: name-only, reference-only, or both. The name defaults to the
 * lookup; pass it only where it comes from somewhere else, like a token symbol.
 */
function referenceFields(
  names: EventNames,
  reference: string | null | undefined,
  labels: { key: string; name: string; reference: string },
  name: string | undefined = nameOf(names, reference)
): DetailField[] {
  const fields: DetailField[] = [];
  if (name && name !== reference) {
    fields.push({ key: `${labels.key}-name`, label: labels.name, value: name });
  }
  if (reference) {
    fields.push({
      key: `${labels.key}-reference`,
      label: labels.reference,
      value: reference,
      breakAll: true,
    });
  }
  return fields;
}

/**
 * Wallet addresses and ids resolve to the same label, and an instance's gateway
 * can arrive from both the payload and the lookup, so identical rows collapse.
 */
function dedupeFields(fields: DetailField[]): DetailField[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    const signature = `${field.label}\u0000${field.value}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

/**
 * A mint's symbol, from the project's issued tokens or the shared well-known
 * catalogue. Deliberately not `resolveTransferTokenLabel`, which falls back to a
 * shortened mint — that is not a name and would only repeat the row below it.
 */
function tokenName(names: EventNames, mint: string | undefined): string | undefined {
  const trimmed = mint?.trim();
  if (!trimmed) return undefined;
  return names[trimmed] ?? WELL_KNOWN_TOKEN_BY_MINT.get(trimmed)?.symbol;
}

function stringifyPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2) ?? "{}";
  } catch {
    return "{}";
  }
}

function publicExplorerSignature(
  event: PrivateChannelEventDto,
  signature: string | undefined
): string | undefined {
  if (!signature) return undefined;
  return event.type.startsWith("transfer.deposit.") ||
    event.type === PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_SETTLED
    ? signature
    : undefined;
}

export function EventDetail({
  event,
  summary,
  formattedOccurredAt,
  canViewRawPayload,
  names = {},
  onClose,
}: EventDetailProps) {
  const t = useTranslations();
  const cluster = useSolanaCluster();

  const eventLabel = eventTypeLabel(t, event.type);
  const explorerSignature = publicExplorerSignature(event, summary.signature);
  const channelName = nameOf(names, event.channelId) ?? summary.channelName;
  const gatewayUrl = nameOf(names, event.instanceId) ?? summary.gatewayUrl;
  const fields = dedupeFields(
    [
      detailField(
        "occurred-at",
        t("DashboardPrivateChannels.events.detailOccurredAt"),
        formattedOccurredAt
      ),
      detailField("amount", t("DashboardPrivateChannels.events.fieldAmount"), summary.amount),
      ...referenceFields(
        names,
        summary.mint,
        {
          key: "mint",
          name: t("DashboardPrivateChannels.events.fieldToken"),
          reference: t("DashboardPrivateChannels.events.fieldMint"),
        },
        tokenName(names, summary.mint)
      ),
      ...referenceFields(names, summary.sender, {
        key: "sender",
        name: t("DashboardPrivateChannels.events.fieldSenderName"),
        reference: t("DashboardPrivateChannels.events.fieldSender"),
      }),
      ...referenceFields(names, summary.recipient, {
        key: "recipient",
        name: t("DashboardPrivateChannels.events.fieldRecipientName"),
        reference: t("DashboardPrivateChannels.events.fieldRecipient"),
      }),
      ...referenceFields(names, summary.pubkey, {
        key: "pubkey",
        name: t("DashboardPrivateChannels.events.fieldWalletName"),
        reference: t("DashboardPrivateChannels.events.fieldWallet"),
      }),
      detailField("reason", t("DashboardPrivateChannels.events.fieldReason"), summary.reason),
      detailField("latency", t("DashboardPrivateChannels.events.fieldLatency"), summary.latencyMs),
      detailField(
        "confirmed-at",
        t("DashboardPrivateChannels.events.fieldConfirmedAt"),
        summary.confirmedAt
      ),
      detailField(
        "signature",
        t("DashboardPrivateChannels.events.fieldSignature"),
        summary.signature,
        true
      ),
      detailField(
        "deposit-id",
        t("DashboardPrivateChannels.events.fieldDepositId"),
        summary.ids.depositId,
        true
      ),
      detailField(
        "withdrawal-id",
        t("DashboardPrivateChannels.events.fieldWithdrawalId"),
        summary.ids.withdrawalId,
        true
      ),
      detailField(
        "transfer-id",
        t("DashboardPrivateChannels.events.fieldTransferId"),
        summary.ids.transferId,
        true
      ),
      ...referenceFields(
        names,
        event.channelId,
        {
          key: "channel",
          name: t("DashboardPrivateChannels.events.fieldChannelName"),
          reference: t("DashboardPrivateChannels.events.fieldChannelId"),
        },
        channelName
      ),
      ...referenceFields(
        names,
        event.instanceId,
        {
          key: "instance",
          name: t("DashboardPrivateChannels.events.fieldGateway"),
          reference: t("DashboardPrivateChannels.events.fieldInstanceId"),
        },
        gatewayUrl
      ),
      ...referenceFields(names, summary.ids.walletId, {
        key: "wallet-id",
        name: t("DashboardPrivateChannels.events.fieldWalletName"),
        reference: t("DashboardPrivateChannels.events.fieldWalletId"),
      }),
      ...referenceFields(names, summary.ids.privateChannelUserId, {
        key: "member",
        name: t("DashboardPrivateChannels.events.fieldMemberName"),
        reference: t("DashboardPrivateChannels.events.fieldMemberId"),
      }),
      ...referenceFields(names, summary.ids.targetUserId, {
        key: "target-user",
        name: t("DashboardPrivateChannels.events.fieldUserName"),
        reference: t("DashboardPrivateChannels.events.fieldUserId"),
      }),
      ...referenceFields(names, event.sdpUserId, {
        key: "actor",
        name: t("DashboardPrivateChannels.events.fieldActor"),
        reference: t("DashboardPrivateChannels.events.fieldActorId"),
      }),
      detailField(
        "membership-id",
        t("DashboardPrivateChannels.events.fieldMembershipId"),
        summary.ids.membershipId,
        true
      ),
      detailField("event-id", t("DashboardPrivateChannels.events.fieldEventId"), event.id, true),
    ].filter((field): field is DetailField => field !== null)
  );

  return (
    <Modal
      isOpen
      ariaLabel={t("DashboardPrivateChannels.events.detailAria", { event: eventLabel })}
      onClose={onClose}
      size="lg"
    >
      <div className="min-w-0">
        <div className="space-y-3 border-b border-border-default p-6">
          <h2 className="pr-10 text-lg font-medium tracking-tight text-primary">{eventLabel}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={EVENT_FAMILY_BADGE[event.family] ?? "default"}>
              {eventFamilyLabel(t, event.family)}
            </Badge>
            <Badge variant={EVENT_STATUS_BADGE[event.status] ?? "default"}>
              {eventStatusLabel(t, event.status)}
            </Badge>
          </div>
        </div>

        <dl className="divide-y divide-border-default px-6">
          {fields.map((field) => (
            <div
              key={field.key}
              className="grid gap-1 py-3 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-4"
            >
              <dt className="text-xs text-tertiary">{field.label}</dt>
              {/* Names and timestamps read badly when broken mid-word; opaque ids and
                  addresses have no break opportunities at all. */}
              <dd
                className={cn(
                  "min-w-0 text-sm text-primary",
                  field.breakAll ? "break-all" : "break-words"
                )}
              >
                {field.value}
              </dd>
            </div>
          ))}
        </dl>

        {explorerSignature || canViewRawPayload ? (
          <div className="space-y-4 border-t border-border-default p-6">
            {explorerSignature ? (
              <a
                className="inline-flex min-w-0 items-center gap-1.5 text-sm text-primary underline underline-offset-2 hover:no-underline"
                href={explorerTxUrl(explorerSignature, cluster)}
                rel="noreferrer"
                target="_blank"
              >
                <span className="min-w-0">
                  {t("DashboardPrivateChannels.events.viewTransaction")}
                </span>
                <ExternalLinkIcon aria-hidden className="size-4 shrink-0" />
              </a>
            ) : null}

            {canViewRawPayload ? (
              <details className="min-w-0">
                <summary className="w-fit cursor-pointer text-sm font-medium text-primary">
                  {t("DashboardPrivateChannels.events.rawPayload")}
                </summary>
                <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-sunken p-3 font-mono text-secondary text-xs">
                  {stringifyPayload(event.payload)}
                </pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
