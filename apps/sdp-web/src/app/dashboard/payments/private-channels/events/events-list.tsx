"use client";

import type { PrivateChannelEventDto } from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslations } from "@/i18n/provider";
import { loadProjectEventsAction } from "./actions";
import {
  EVENT_FAMILY_BADGE,
  EVENT_STATUS_BADGE,
  eventFamilyLabel,
  eventStatusLabel,
  eventTypeLabel,
} from "./event-labels";

interface Props {
  initialEvents: PrivateChannelEventDto[];
  initialHasMore: boolean;
  initialNextCursor: string | null;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function payloadPreview(payload: Record<string, unknown>): string | null {
  const keys = Object.keys(payload);
  if (keys.length === 0) return null;
  try {
    const text = JSON.stringify(payload);
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  } catch {
    return null;
  }
}

export function EventsList({ initialEvents, initialHasMore, initialNextCursor }: Props) {
  const [events, setEvents] = useState(initialEvents);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [isLoadingMore, startLoadMore] = useTransition();
  const t = useTranslations();

  function loadMore() {
    if (!nextCursor || isLoadingMore) return;
    startLoadMore(async () => {
      const result = await loadProjectEventsAction({ before: nextCursor, limit: 50 });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setEvents((prev) => [...prev, ...result.data.events]);
      setHasMore(result.data.hasMore);
      setNextCursor(result.data.nextCursor);
    });
  }

  if (events.length === 0) {
    return <p className="text-secondary text-sm">{t("DashboardPrivateChannels.events.empty")}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border border-border-default">
        <Table>
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => {
              const preview = payloadPreview(event.payload);
              return (
                <TableRow key={event.id}>
                  <TableCell className="max-w-0">
                    <span className="text-primary">{eventTypeLabel(t, event.type)}</span>
                    {preview ? (
                      <span
                        className="mt-0.5 block truncate font-mono text-tertiary text-xs"
                        title={preview}
                      >
                        {preview}
                      </span>
                    ) : null}
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
                    <span className="block whitespace-nowrap">{formatWhen(event.occurredAt)}</span>
                    {event.channelId ? (
                      <span className="mt-0.5 block truncate font-mono text-tertiary text-xs">
                        {event.channelId}
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {hasMore ? (
        <div className="flex justify-center">
          <Button type="button" variant="secondary" onClick={loadMore} disabled={isLoadingMore}>
            {isLoadingMore ? <Loader2Icon className="animate-spin" /> : null}
            {t("DashboardPrivateChannels.events.loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
