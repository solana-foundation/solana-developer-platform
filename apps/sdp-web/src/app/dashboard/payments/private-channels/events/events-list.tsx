"use client";

import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  type PrivateChannelEventDto,
  type PrivateChannelEventFamily,
} from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  formatTokenAmount,
  resolveTransferTokenLabel,
  shortenAddress,
} from "../../payments-overview.utils";
import { loadProjectEventsAction } from "./actions";
import { EventDetail } from "./event-detail";
import {
  EVENT_FAMILY_BADGE,
  EVENT_STATUS_BADGE,
  eventFamilyLabel,
  eventStatusLabel,
  eventTypeLabel,
} from "./event-labels";
import { type PrivateChannelEventSummary, summarizePrivateChannelEvent } from "./event-summary";

interface Props {
  initialEvents: PrivateChannelEventDto[];
  initialHasMore: boolean;
  initialNextCursor: string | null;
  canViewRawPayload: boolean;
}

type Translate = (key: MessageKey, values?: TranslationValues) => string;
type EventFamilyFilter = "all" | PrivateChannelEventFamily;

const FAMILY_FILTERS = [
  "all",
  PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE,
  PRIVATE_CHANNEL_EVENT_FAMILIES.MEMBER,
  PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
  PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR,
] as const satisfies readonly EventFamilyFilter[];

function formatWhen(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function resolveFamilyFilter(value: string | null): EventFamilyFilter | null {
  return FAMILY_FILTERS.find((family) => family === value) ?? null;
}

function rowAmount(summary: PrivateChannelEventSummary, locale: string): string | undefined {
  const token = resolveTransferTokenLabel(summary.mint);
  const amount = summary.amount ? formatTokenAmount(summary.amount, locale) : undefined;
  if (amount && token) return `${amount} ${token}`;
  return amount ?? token;
}

function shortValue(value: string | undefined): string | undefined {
  return value ? shortenAddress(value) : undefined;
}

function amountTo(t: Translate, amount: string | undefined, counterparty: string | undefined) {
  return amount && counterparty
    ? t("DashboardPrivateChannels.events.summaryTo", { amount, counterparty })
    : undefined;
}

function amountFrom(t: Translate, amount: string | undefined, counterparty: string | undefined) {
  return amount && counterparty
    ? t("DashboardPrivateChannels.events.summaryFrom", { amount, counterparty })
    : undefined;
}

/** Deposits and withdrawals move funds across the channel boundary in one direction. */
function movementSummary(
  t: Translate,
  summary: PrivateChannelEventSummary,
  amount: string | undefined
): string | undefined {
  return (
    amountTo(t, amount, shortValue(summary.recipient)) ??
    amountFrom(t, amount, shortValue(summary.sender))
  );
}

function transferSummary(
  t: Translate,
  summary: PrivateChannelEventSummary,
  amount: string | undefined
): string | undefined {
  const sender = shortValue(summary.sender);
  const recipient = shortValue(summary.recipient);
  if (amount && sender && recipient) {
    return t("DashboardPrivateChannels.events.summaryTransfer", {
      amount,
      sender,
      recipient,
    });
  }
  if (sender && recipient) {
    return t("DashboardPrivateChannels.events.summaryDirection", { sender, recipient });
  }
  return amountTo(t, amount, recipient);
}

function formatRowSummary(
  t: Translate,
  summary: PrivateChannelEventSummary,
  locale: string
): string {
  const amount = rowAmount(summary, locale);
  const directionalSummary =
    (summary.kind === "deposit" || summary.kind === "withdrawal"
      ? movementSummary(t, summary, amount)
      : undefined) ??
    (summary.kind === "transfer" ? transferSummary(t, summary, amount) : undefined);
  if (directionalSummary) return directionalSummary;

  if (summary.pubkey) {
    return t("DashboardPrivateChannels.events.summaryWallet", {
      wallet: shortenAddress(summary.pubkey),
    });
  }
  if (summary.channelName) {
    return t("DashboardPrivateChannels.events.summaryChannel", {
      channel: summary.channelName,
    });
  }
  if (summary.kind === "instance" && summary.gatewayUrl) {
    return t("DashboardPrivateChannels.events.summaryGateway", {
      gateway: summary.gatewayUrl,
    });
  }
  if (summary.reason) return summary.reason;
  if (amount) return amount;

  const memberId = summary.ids.targetUserId ?? summary.ids.privateChannelUserId;
  if (memberId) {
    return t("DashboardPrivateChannels.events.summaryMember", {
      member: shortenAddress(memberId),
    });
  }

  const firstId = Object.values(summary.ids)[0];
  if (firstId) {
    return t("DashboardPrivateChannels.events.summaryReference", {
      reference: shortenAddress(firstId),
    });
  }

  return t("DashboardPrivateChannels.events.noAdditionalDetails");
}

export function EventsList({
  initialEvents,
  initialHasMore,
  initialNextCursor,
  canViewRawPayload,
}: Props) {
  const [events, setEvents] = useState(initialEvents);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [selectedFamily, setSelectedFamily] = useState<EventFamilyFilter>("all");
  const [selectedEvent, setSelectedEvent] = useState<PrivateChannelEventDto | null>(null);
  const [isLoadingMore, startLoadMore] = useTransition();
  const [isFiltering, startFiltering] = useTransition();
  const t = useTranslations();
  const locale = useLocale();
  const isBusy = isLoadingMore || isFiltering;

  function familyParam(family: EventFamilyFilter): { family?: PrivateChannelEventFamily } {
    return family === "all" ? {} : { family };
  }

  function changeFamily(value: string | null) {
    const nextFamily = resolveFamilyFilter(value);
    if (!nextFamily || nextFamily === selectedFamily || isBusy) return;

    const previousFamily = selectedFamily;
    setSelectedFamily(nextFamily);
    startFiltering(async () => {
      const result = await loadProjectEventsAction({
        limit: 50,
        ...familyParam(nextFamily),
      });
      if (!result.ok) {
        setSelectedFamily(previousFamily);
        toast.error(t("DashboardPrivateChannels.events.loadErrorToast"));
        return;
      }
      setEvents(result.data.events);
      setHasMore(result.data.hasMore);
      setNextCursor(result.data.nextCursor);
      setSelectedEvent(null);
    });
  }

  function loadMore() {
    if (!nextCursor || isBusy) return;
    startLoadMore(async () => {
      const result = await loadProjectEventsAction({
        before: nextCursor,
        limit: 50,
        ...familyParam(selectedFamily),
      });
      if (!result.ok) {
        toast.error(t("DashboardPrivateChannels.events.loadErrorToast"));
        return;
      }
      setEvents((prev) => [...prev, ...result.data.events]);
      setHasMore(result.data.hasMore);
      setNextCursor(result.data.nextCursor);
    });
  }

  const selectedSummary = selectedEvent ? summarizePrivateChannelEvent(selectedEvent) : null;

  return (
    <div className="flex min-w-0 flex-col gap-4" aria-busy={isBusy}>
      {canViewRawPayload ? (
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <span className="text-sm font-medium text-primary">
            {t("DashboardPrivateChannels.events.filterLabel")}
          </span>
          <Select
            ariaLabel={t("DashboardPrivateChannels.events.filterLabel")}
            className="w-full max-w-full sm:w-64"
            disabled={isBusy}
            onValueChange={changeFamily}
            trailing={
              isFiltering ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : null
            }
            value={selectedFamily}
          >
            <SelectItem value="all">{t("DashboardPrivateChannels.events.filterAll")}</SelectItem>
            <SelectItem value={PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE}>
              {eventFamilyLabel(t, PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE)}
            </SelectItem>
            <SelectItem value={PRIVATE_CHANNEL_EVENT_FAMILIES.MEMBER}>
              {eventFamilyLabel(t, PRIVATE_CHANNEL_EVENT_FAMILIES.MEMBER)}
            </SelectItem>
            <SelectItem value={PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER}>
              {eventFamilyLabel(t, PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER)}
            </SelectItem>
            <SelectItem value={PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR}>
              {eventFamilyLabel(t, PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR)}
            </SelectItem>
          </Select>
        </div>
      ) : null}

      {events.length === 0 ? (
        <p className="text-secondary text-sm">
          {selectedFamily === "all"
            ? t("DashboardPrivateChannels.events.empty")
            : t("DashboardPrivateChannels.events.emptyFiltered")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-default">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/2">
                  {t("DashboardPrivateChannels.events.columnEvent")}
                </TableHead>
                <TableHead className="w-28">
                  {t("DashboardPrivateChannels.events.columnCategory")}
                </TableHead>
                <TableHead className="w-24">
                  {t("DashboardPrivateChannels.events.columnStatus")}
                </TableHead>
                <TableHead className="w-44">
                  {t("DashboardPrivateChannels.events.columnWhen")}
                </TableHead>
                <TableHead className="w-28 text-right">
                  {t("DashboardPrivateChannels.events.columnDetails")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => {
                const eventLabel = eventTypeLabel(t, event.type);
                const summary = summarizePrivateChannelEvent(event);
                const rowSummary = formatRowSummary(t, summary, locale);
                return (
                  <TableRow key={event.id}>
                    <TableCell className="max-w-0">
                      <div className="min-w-0">
                        <span className="block truncate text-primary" title={eventLabel}>
                          {eventLabel}
                        </span>
                        <span
                          className="mt-0.5 block truncate text-tertiary text-xs"
                          title={rowSummary}
                        >
                          {rowSummary}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={EVENT_FAMILY_BADGE[event.family] ?? "default"}>
                        {eventFamilyLabel(t, event.family)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={EVENT_STATUS_BADGE[event.status] ?? "default"}>
                        {eventStatusLabel(t, event.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-0 text-secondary">
                      <span className="block whitespace-nowrap">
                        {formatWhen(event.occurredAt, locale)}
                      </span>
                      {event.channelId ? (
                        <span
                          className="mt-0.5 block truncate text-tertiary text-xs"
                          title={event.channelId}
                        >
                          {event.channelId}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        aria-label={t("DashboardPrivateChannels.events.viewDetailsAria", {
                          event: eventLabel,
                        })}
                        onClick={() => setSelectedEvent(event)}
                        size="xs"
                        variant="ghost"
                      >
                        {t("DashboardPrivateChannels.events.viewDetails")}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {events.length > 0 && hasMore ? (
        <div className="flex justify-center">
          <Button type="button" variant="secondary" onClick={loadMore} disabled={isBusy}>
            {isLoadingMore ? <Loader2Icon className="animate-spin" /> : null}
            {t("DashboardPrivateChannels.events.loadMore")}
          </Button>
        </div>
      ) : null}

      {selectedEvent && selectedSummary ? (
        <EventDetail
          event={selectedEvent}
          summary={selectedSummary}
          formattedOccurredAt={formatWhen(selectedEvent.occurredAt, locale)}
          canViewRawPayload={canViewRawPayload}
          onClose={() => setSelectedEvent(null)}
        />
      ) : null}
    </div>
  );
}
