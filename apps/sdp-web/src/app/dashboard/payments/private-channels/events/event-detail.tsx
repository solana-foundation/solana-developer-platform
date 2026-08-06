"use client";

import { PRIVATE_CHANNEL_EVENT_TYPES, type PrivateChannelEventDto } from "@sdp/types";
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import {
  EVENT_FAMILY_BADGE,
  EVENT_STATUS_BADGE,
  eventFamilyLabel,
  eventStatusLabel,
  eventTypeLabel,
} from "./event-labels";
import type { PrivateChannelEventSummary } from "./event-summary";

interface EventDetailProps {
  event: PrivateChannelEventDto;
  summary: PrivateChannelEventSummary;
  formattedOccurredAt: string;
  canViewRawPayload: boolean;
  onClose: () => void;
}

interface DetailField {
  label: string;
  value: string;
  breakAll?: boolean;
}

function detailField(
  label: string,
  value: string | null | undefined,
  breakAll = false
): DetailField | null {
  if (!value) return null;
  return breakAll ? { label, value, breakAll: true } : { label, value };
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
  onClose,
}: EventDetailProps) {
  const t = useTranslations();
  const cluster = useSolanaCluster();

  const eventLabel = eventTypeLabel(t, event.type);
  const explorerSignature = publicExplorerSignature(event, summary.signature);
  const fields = [
    detailField(t("DashboardPrivateChannels.events.detailOccurredAt"), formattedOccurredAt),
    detailField(t("DashboardPrivateChannels.events.fieldAmount"), summary.amount),
    detailField(t("DashboardPrivateChannels.events.fieldMint"), summary.mint, true),
    detailField(t("DashboardPrivateChannels.events.fieldSender"), summary.sender, true),
    detailField(t("DashboardPrivateChannels.events.fieldRecipient"), summary.recipient, true),
    detailField(t("DashboardPrivateChannels.events.fieldWallet"), summary.pubkey, true),
    detailField(t("DashboardPrivateChannels.events.fieldChannelName"), summary.channelName),
    detailField(t("DashboardPrivateChannels.events.fieldReason"), summary.reason),
    detailField(t("DashboardPrivateChannels.events.fieldGateway"), summary.gatewayUrl, true),
    detailField(t("DashboardPrivateChannels.events.fieldLatency"), summary.latencyMs),
    detailField(t("DashboardPrivateChannels.events.fieldConfirmedAt"), summary.confirmedAt),
    detailField(t("DashboardPrivateChannels.events.fieldSignature"), summary.signature, true),
    detailField(t("DashboardPrivateChannels.events.fieldDepositId"), summary.ids.depositId, true),
    detailField(
      t("DashboardPrivateChannels.events.fieldWithdrawalId"),
      summary.ids.withdrawalId,
      true
    ),
    detailField(t("DashboardPrivateChannels.events.fieldTransferId"), summary.ids.transferId, true),
    detailField(t("DashboardPrivateChannels.events.fieldChannelId"), event.channelId, true),
    detailField(t("DashboardPrivateChannels.events.fieldInstanceId"), event.instanceId, true),
    detailField(t("DashboardPrivateChannels.events.fieldWalletId"), summary.ids.walletId, true),
    detailField(
      t("DashboardPrivateChannels.events.fieldMemberId"),
      summary.ids.privateChannelUserId,
      true
    ),
    detailField(t("DashboardPrivateChannels.events.fieldUserId"), summary.ids.targetUserId, true),
    detailField(
      t("DashboardPrivateChannels.events.fieldMembershipId"),
      summary.ids.membershipId,
      true
    ),
    detailField(t("DashboardPrivateChannels.events.fieldEventId"), event.id, true),
  ].filter((field): field is DetailField => field !== null);

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
              key={field.label}
              className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(8rem,150px)_minmax(0,1fr)] sm:gap-4"
            >
              <dt className="text-xs text-tertiary">{field.label}</dt>
              <dd
                className={
                  field.breakAll
                    ? "min-w-0 break-all text-sm text-primary"
                    : "min-w-0 break-words text-sm text-primary"
                }
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
