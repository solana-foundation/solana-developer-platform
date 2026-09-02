"use client";

import type { PrivateChannelDto } from "@sdp/types";
import { ArrowRightIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { useTranslations } from "@/i18n/provider";
import { privateChannelPath } from "../private-channels-routes";

export function ChannelDirectoryRow({
  channel,
  instanceId,
  instanceAddress,
  walletCount,
  tokensSummary,
}: {
  channel: PrivateChannelDto;
  instanceId: string;
  instanceAddress: string;
  walletCount: number;
  tokensSummary: string;
}) {
  const router = useRouter();
  const t = useTranslations();
  const href = privateChannelPath(instanceId, channel.id);
  const open = () => router.push(href);

  return (
    <TableRow
      aria-label={t("DashboardPrivateChannels.directory.openChannel", { channel: channel.name })}
      className="group cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
      role="link"
      tabIndex={0}
    >
      <TableCell>
        <span className="font-medium text-primary group-hover:underline">{channel.name}</span>
        {channel.description ? (
          <p className="mt-0.5 max-w-xs truncate text-xs text-tertiary">{channel.description}</p>
        ) : null}
      </TableCell>
      <TableCell className="text-secondary" title={instanceAddress}>
        {instanceAddress}
      </TableCell>
      <TableCell className="text-secondary">
        {t("DashboardPrivateChannels.directory.walletCount", { count: walletCount })}
      </TableCell>
      <TableCell className="text-secondary">{tokensSummary}</TableCell>
      <TableCell>
        <Badge variant="success">{t("DashboardPrivateChannels.directory.connected")}</Badge>
      </TableCell>
      <TableCell align="right">
        <ArrowRightIcon
          aria-hidden
          className="ml-auto size-5 text-secondary group-hover:text-primary"
        />
      </TableCell>
    </TableRow>
  );
}
