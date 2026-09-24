"use client";

import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  type PrivateChannelEventDto,
  type PrivateChannelEventFamily,
} from "@sdp/types";
import { ChevronRightIcon, Loader2Icon } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  formatTokenAmount,
  resolveTransferTokenLabel,
} from "@/app/dashboard/payments/payments-overview.utils";
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
import { type LoadEventsResult, loadProjectEventsAction } from "./actions";
import { EventDetail } from "./event-detail";
import {
  EVENT_FAMILY_BADGE,
  EVENT_STATUS_BADGE,
  eventFamilyLabel,
  eventStatusLabel,
  eventTypeLabel,
} from "./event-labels";
import { type EventNames, labelFor } from "./event-names";
import { type PrivateChannelEventSummary, summarizePrivateChannelEvent } from "./event-summary";

interface Props {
  /**
   * The page's immutable project scope. Follow-up loads re-bind to it instead
   * of the shared selection cookie, and responses carrying another project's
   * rows are dropped, so a mounted feed can never mix projects.
   */
  projectId: string;
  initialEvents: PrivateChannelEventDto[];
  initialHasMore: boolean;
  initialNextCursor: string | null;
  canViewRawPayload: boolean;
  names?: EventNames;
}

type Translate = (key: MessageKey, values?: TranslationValues) => string;
type EventFamilyFilter = "all" | PrivateChannelEventFamily;

/** The rendered feed plus the project scope its rows and cursor belong to. */
interface FeedState {
  scope: string;
  events: PrivateChannelEventDto[];
  hasMore: boolean;
  nextCursor: string | null;
}

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

function rowAmount(
  summary: PrivateChannelEventSummary,
  locale: string,
  names: EventNames
): string | undefined {
  // `names` carries mint -> symbol for the project's issued tokens; well-known
  // mints still resolve from the shared catalogue.
  const token = resolveTransferTokenLabel(summary.mint, names);
  const amount = summary.amount ? formatTokenAmount(summary.amount, locale) : undefined;
  if (amount && token) return `${amount} ${token}`;
  return amount ?? token;
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
  amount: string | undefined,
  names: EventNames
): string | undefined {
  return (
    amountTo(t, amount, labelFor(names, summary.recipient)) ??
    amountFrom(t, amount, labelFor(names, summary.sender))
  );
}

function transferSummary(
  t: Translate,
  summary: PrivateChannelEventSummary,
  amount: string | undefined,
  names: EventNames
): string | undefined {
  const sender = labelFor(names, summary.sender);
  const recipient = labelFor(names, summary.recipient);
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
  locale: string,
  names: EventNames
): string {
  const amount = rowAmount(summary, locale, names);
  const directionalSummary =
    (summary.kind === "deposit" || summary.kind === "withdrawal"
      ? movementSummary(t, summary, amount, names)
      : undefined) ??
    (summary.kind === "transfer" ? transferSummary(t, summary, amount, names) : undefined);
  if (directionalSummary) return directionalSummary;

  if (summary.pubkey) {
    return t("DashboardPrivateChannels.events.summaryWallet", {
      wallet: labelFor(names, summary.pubkey),
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
      member: labelFor(names, memberId),
    });
  }

  const firstId = Object.values(summary.ids)[0];
  if (firstId) {
    return t("DashboardPrivateChannels.events.summaryReference", {
      reference: labelFor(names, firstId),
    });
  }

  return t("DashboardPrivateChannels.events.noAdditionalDetails");
}

export function EventsList({
  projectId,
  initialEvents,
  initialHasMore,
  initialNextCursor,
  canViewRawPayload,
  names = {},
}: Props) {
  const [feed, setFeed] = useState<FeedState>(() => ({
    scope: projectId,
    events: initialEvents,
    hasMore: initialHasMore,
    nextCursor: initialNextCursor,
  }));
  const [selectedFamily, setSelectedFamily] = useState<EventFamilyFilter>("all");
  const [selectedEvent, setSelectedEvent] = useState<PrivateChannelEventDto | null>(null);
  const [isLoadingMore, startLoadMore] = useTransition();
  const [isFiltering, startFiltering] = useTransition();
  const t = useTranslations();
  const locale = useLocale();
  const isBusy = isLoadingMore || isFiltering;

  // The page scope is the feed's identity: when it changes, rows, cursor, and
  // selection reset to the new scope's initial data instead of surviving.
  if (feed.scope !== projectId) {
    setFeed({
      scope: projectId,
      events: initialEvents,
      hasMore: initialHasMore,
      nextCursor: initialNextCursor,
    });
    setSelectedFamily("all");
    setSelectedEvent(null);
  }

  function familyParam(family: EventFamilyFilter): { family?: PrivateChannelEventFamily } {
    return family === "all" ? {} : { family };
  }

  /**
   * The response only feeds the mounted project: a page whose rows name
   * another project is dropped whole (never partially applied), the same way
   * a failed load is.
   */
  function responseInScope(
    result: LoadEventsResult,
    scope: string
  ): (LoadEventsResult & { ok: true }) | null {
    if (!result.ok) return null;
    return result.data.events.every((event) => event.projectId === scope) ? result : null;
  }

  function changeFamily(value: string | null) {
    const nextFamily = resolveFamilyFilter(value);
    if (!nextFamily || nextFamily === selectedFamily || isBusy) return;

    const previousFamily = selectedFamily;
    setSelectedFamily(nextFamily);
    startFiltering(async () => {
      const result = await loadProjectEventsAction({
        projectId,
        limit: 50,
        ...familyParam(nextFamily),
      });
      const page = responseInScope(result, projectId);
      if (!page) {
        setSelectedFamily((current) => (current === nextFamily ? previousFamily : current));
        toast.error(t("DashboardPrivateChannels.events.loadErrorToast"));
        return;
      }
      // Functional so a response that resolves after the scope moved on is
      // dropped rather than written into the new scope's feed.
      setFeed((prev) =>
        prev.scope === projectId
          ? {
              scope: prev.scope,
              events: page.data.events,
              hasMore: page.data.hasMore,
              nextCursor: page.data.nextCursor,
            }
          : prev
      );
      setSelectedEvent(null);
    });
  }

  function loadMore() {
    const cursor = feed.nextCursor;
    if (!cursor || isBusy) return;
    startLoadMore(async () => {
      const result = await loadProjectEventsAction({
        projectId,
        before: cursor,
        limit: 50,
        ...familyParam(selectedFamily),
      });
      const page = responseInScope(result, projectId);
      if (!page) {
        toast.error(t("DashboardPrivateChannels.events.loadErrorToast"));
        return;
      }
      setFeed((prev) =>
        prev.scope === projectId
          ? {
              scope: prev.scope,
              events: [...prev.events, ...page.data.events],
              hasMore: page.data.hasMore,
              nextCursor: page.data.nextCursor,
            }
          : prev
      );
    });
  }

  const selectedSummary = selectedEvent ? summarizePrivateChannelEvent(selectedEvent) : null;

  // Derived once so the stacked and tabular layouts can never drift apart.
  const rows = useMemo(
    () =>
      feed.events.map((event) => {
        const summary = summarizePrivateChannelEvent(event);
        return {
          event,
          label: eventTypeLabel(t, event.type),
          detail: formatRowSummary(t, summary, locale, names),
          when: formatWhen(event.occurredAt, locale),
          channelLabel: labelFor(names, event.channelId) ?? null,
        };
      }),
    [feed.events, locale, names, t]
  );

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

      {feed.events.length === 0 ? (
        <p className="text-secondary text-sm">
          {selectedFamily === "all"
            ? t("DashboardPrivateChannels.events.empty")
            : t("DashboardPrivateChannels.events.emptyFiltered")}
        </p>
      ) : (
        <>
          {/* Below lg the five columns only fit behind a horizontal scrollbar, so each
              event collapses into a tappable row that opens the same detail modal. */}
          <ul className="flex flex-col divide-y divide-border-default overflow-hidden rounded-lg border border-border-default lg:hidden">
            {rows.map((row) => (
              <li key={row.event.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-fill-subtle"
                  onClick={() => setSelectedEvent(row.event)}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-primary text-sm">{row.label}</span>
                      <Badge variant={EVENT_STATUS_BADGE[row.event.status] ?? "default"}>
                        {eventStatusLabel(t, row.event.status)}
                      </Badge>
                    </span>
                    <span className="block truncate text-tertiary text-xs">{row.detail}</span>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-tertiary text-xs">
                      <Badge variant={EVENT_FAMILY_BADGE[row.event.family] ?? "default"}>
                        {eventFamilyLabel(t, row.event.family)}
                      </Badge>
                      <span className="whitespace-nowrap">{row.when}</span>
                      {row.channelLabel ? (
                        <span className="min-w-0 truncate">{row.channelLabel}</span>
                      ) : null}
                    </span>
                  </span>
                  <ChevronRightIcon className="size-4 shrink-0 text-tertiary" />
                </button>
              </li>
            ))}
          </ul>

          {/* Table brings its own frame and horizontal scroll, so no wrapper is needed. */}
          <Table className="hidden [&_table]:min-w-[760px] lg:block">
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
              {rows.map((row) => (
                <TableRow key={row.event.id}>
                  <TableCell className="max-w-0">
                    <div className="min-w-0">
                      <span className="block truncate text-primary" title={row.label}>
                        {row.label}
                      </span>
                      <span
                        className="mt-0.5 block truncate text-tertiary text-xs"
                        title={row.detail}
                      >
                        {row.detail}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={EVENT_FAMILY_BADGE[row.event.family] ?? "default"}>
                      {eventFamilyLabel(t, row.event.family)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={EVENT_STATUS_BADGE[row.event.status] ?? "default"}>
                      {eventStatusLabel(t, row.event.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-0 text-secondary">
                    <span className="block whitespace-nowrap">{row.when}</span>
                    {row.channelLabel ? (
                      <span
                        className="mt-0.5 block truncate text-tertiary text-xs"
                        title={row.event.channelId ?? row.channelLabel}
                      >
                        {row.channelLabel}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      aria-label={t("DashboardPrivateChannels.events.viewDetailsAria", {
                        event: row.label,
                      })}
                      onClick={() => setSelectedEvent(row.event)}
                      size="xs"
                      variant="ghost"
                    >
                      {t("DashboardPrivateChannels.events.viewDetails")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}

      {feed.events.length > 0 && feed.hasMore ? (
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
          names={names}
          onClose={() => setSelectedEvent(null)}
        />
      ) : null}
    </div>
  );
}
