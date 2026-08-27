"use client";

import type { PrivateChannelEventDto } from "@sdp/types";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { Loader2Icon, PlusIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslations } from "@/i18n/provider";
import { loadProjectEventsAction } from "../events/actions";
import { EVENT_STATUS_BADGE, eventStatusLabel, eventTypeLabel } from "../events/event-labels";
import { eventMint } from "./overview-data";

const TRANSFER_HREF = "/dashboard/integrations/private-channels/transfer";
const ALL_ACTIVITY_HREF = "/dashboard/integrations/private-channels/events";

/** The overview only previews the most recent activity — the rest lives on the events page. */
const MAX_RECENT_EVENTS = 10;

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

interface Props {
  initialEvents: PrivateChannelEventDto[];
  /** Channel id → display name, for the Channel column. */
  channelNames: Record<string, string>;
  /** The initial events load failed — distinguish "couldn't load" from "none yet". */
  loadError: boolean;
}

export function RecentActivityPanel({ initialEvents, channelNames, loadError }: Props) {
  const t = useTranslations();
  const [events, setEvents] = useState(initialEvents);
  const [loadFailed, setLoadFailed] = useState(loadError);
  const [refreshing, startRefresh] = useTransition();

  function handleRefresh() {
    startRefresh(async () => {
      const result = await loadProjectEventsAction({ limit: 50 });
      if (result.ok) {
        setEvents(result.data.events);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
        toast.error(t("DashboardPrivateChannels.overview.activityLoadError"));
      }
    });
  }

  const none = t("DashboardPrivateChannels.overview.valueNone");
  // Events arrive newest-first; preview only the most recent — "View all" has the rest.
  const recentEvents = events.slice(0, MAX_RECENT_EVENTS);

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader>
        <CardTitle>{t("DashboardPrivateChannels.overview.activityTitle")}</CardTitle>
        <CardAction className="flex items-center gap-2">
          <Button asChild variant="secondary" size="sm" iconLeft={<PlusIcon />}>
            <Link href={TRANSFER_HREF}>
              {t("DashboardPrivateChannels.overview.activityNewTransfer")}
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            iconLeft={refreshing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
          >
            {t("DashboardPrivateChannels.overview.activityRefresh")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        {events.length > 0 ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("DashboardPrivateChannels.overview.colStatus")}</TableHead>
                  <TableHead>{t("DashboardPrivateChannels.overview.colType")}</TableHead>
                  <TableHead>{t("DashboardPrivateChannels.overview.colToken")}</TableHead>
                  <TableHead>{t("DashboardPrivateChannels.overview.colChannel")}</TableHead>
                  <TableHead>{t("DashboardPrivateChannels.overview.colCreated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentEvents.map((event) => {
                  const mint = eventMint(event);
                  const symbol = mint ? (WELL_KNOWN_TOKEN_BY_MINT.get(mint)?.symbol ?? null) : null;
                  const channelName = event.channelId ? channelNames[event.channelId] : null;
                  return (
                    <TableRow key={event.id}>
                      <TableCell>
                        <Badge variant={EVENT_STATUS_BADGE[event.status]}>
                          {eventStatusLabel(t, event.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>{eventTypeLabel(t, event.type)}</TableCell>
                      <TableCell>
                        {mint ? (
                          <span className="flex items-center gap-2">
                            <TokenMark mint={mint} symbol={symbol} size="sm" />
                            <span className="text-secondary">
                              {symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`}
                            </span>
                          </span>
                        ) : (
                          <span className="text-tertiary">{none}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {channelName ?? <span className="text-tertiary">{none}</span>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-secondary">
                        {formatWhen(event.occurredAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : loadFailed ? (
          <p className="py-8 text-center text-sm text-error">
            {t("DashboardPrivateChannels.overview.activityLoadError")}
          </p>
        ) : (
          <p className="py-8 text-center text-sm text-secondary">
            {t("DashboardPrivateChannels.overview.activityEmpty")}
          </p>
        )}
      </CardContent>
      <CardFooter>
        <Link href={ALL_ACTIVITY_HREF} className="text-sm text-info hover:underline">
          {t("DashboardPrivateChannels.overview.activityViewAll")}
        </Link>
      </CardFooter>
    </Card>
  );
}
