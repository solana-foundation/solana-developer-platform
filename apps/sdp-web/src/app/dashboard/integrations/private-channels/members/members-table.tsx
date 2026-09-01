"use client";

import type { PrivateChannelDto, PrivateChannelPrincipalDto } from "@sdp/types";
import { EllipsisIcon, Loader2Icon, PlusIcon, PowerIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Modal } from "@/components/ui/modal";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  addPrincipalToChannelAction,
  disablePrincipalAction,
  removePrincipalFromChannelAction,
} from "./actions";

interface Props {
  principals: PrivateChannelPrincipalDto[];
  channels: PrivateChannelDto[];
}

export function MembersTable({ principals, channels }: Props) {
  const [disableTarget, setDisableTarget] = useState<PrivateChannelPrincipalDto | null>(null);
  const t = useTranslations();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-secondary">
          {principals.length === 1
            ? t("DashboardPrivateChannels.members.countOne", { count: principals.length })
            : t("DashboardPrivateChannels.members.countOther", { count: principals.length })}
        </p>
        <Button asChild>
          <Link href="/dashboard/integrations/private-channels/members/create">
            {t("DashboardPrivateChannels.members.addPrincipal")}
          </Link>
        </Button>
      </div>

      {principals.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-default p-8 text-center text-sm text-secondary">
          {t("DashboardPrivateChannels.members.empty")}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("DashboardPrivateChannels.members.columnPrincipal")}</TableHead>
              <TableHead>{t("DashboardPrivateChannels.members.columnVerifiedWallets")}</TableHead>
              <TableHead>{t("DashboardPrivateChannels.members.columnChannels")}</TableHead>
              <TableHead className="text-right">
                {t("DashboardPrivateChannels.members.columnActions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {principals.map((principal) => (
              <PrincipalRow
                key={principal.id}
                principal={principal}
                allChannels={channels}
                onDisable={() => setDisableTarget(principal)}
              />
            ))}
          </TableBody>
        </Table>
      )}

      <DisablePrincipalDialog target={disableTarget} onClose={() => setDisableTarget(null)} />
    </div>
  );
}

function PrincipalRow({
  principal,
  allChannels,
  onDisable,
}: {
  principal: PrivateChannelPrincipalDto;
  allChannels: PrivateChannelDto[];
  onDisable: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const t = useTranslations();
  const disabled = principal.status === "disabled";
  const channelIds = new Set(principal.channels.map((channel) => channel.id));
  const availableChannels = allChannels.filter((channel) => !channelIds.has(channel.id));

  const addToChannel = (channelId: string) => {
    startTransition(async () => {
      const result = await addPrincipalToChannelAction(channelId, principal.id);
      if (!result.ok) toast.error(result.message);
    });
  };

  const removeFromChannel = (channelId: string) => {
    startTransition(async () => {
      const result = await removePrincipalFromChannelAction(channelId, principal.id);
      if (!result.ok) toast.error(result.message);
    });
  };

  return (
    <TableRow className={cn(disabled && "opacity-55")}>
      <TableCell className="text-sm">{principal.name}</TableCell>
      <TableCell>
        <WalletCountBadge count={principal.verifiedWalletCount} />
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          {principal.channels.map((channel) => (
            <ChannelChip
              key={channel.id}
              label={
                channel.name +
                (channel.isDefault ? ` ${t("DashboardPrivateChannels.members.defaultSuffix")}` : "")
              }
              onRemove={pending || disabled ? undefined : () => removeFromChannel(channel.id)}
            />
          ))}
          {!disabled && availableChannels.length > 0 ? (
            <AddToChannelMenu
              channels={availableChannels}
              disabled={pending}
              onPick={addToChannel}
            />
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-right">
        {!principal.isDefault && !disabled ? (
          <PrincipalActionsMenu
            principalName={principal.name}
            disabled={pending}
            onDisable={onDisable}
          />
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function PrincipalActionsMenu({
  principalName,
  disabled,
  onDisable,
}: {
  principalName: string;
  disabled: boolean;
  onDisable: () => void;
}) {
  const t = useTranslations();

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t("DashboardPrivateChannels.members.principalActionsFor", {
            principal: principalName,
          })}
          disabled={disabled}
        >
          <EllipsisIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem className="justify-center" onSelect={onDisable}>
          <PowerIcon className="h-4 w-4" />
          {t("DashboardPrivateChannels.members.disable")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WalletCountBadge({ count }: { count: number }) {
  const t = useTranslations();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm",
        count > 0 ? "text-status-success-text" : "text-secondary"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-2 rounded-full",
          count > 0 ? "bg-status-success-text" : "bg-fill"
        )}
      />
      {t("DashboardPrivateChannels.members.verifiedCount", { count })}
    </span>
  );
}

function ChannelChip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  const t = useTranslations();
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-fill-subtle px-2 py-0.5 text-xs text-primary">
      {label}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="rounded-full p-0.5 text-secondary hover:bg-fill hover:text-status-error-text"
          aria-label={t("DashboardPrivateChannels.members.removeFromAria", { label })}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

function AddToChannelMenu({
  channels,
  disabled,
  onPick,
}: {
  channels: PrivateChannelDto[];
  disabled: boolean;
  onPick: (channelId: string) => void;
}) {
  const t = useTranslations();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-default px-2 py-0.5 text-xs text-secondary hover:bg-fill-subtle hover:text-primary disabled:opacity-40"
        >
          <PlusIcon className="size-3" />
          {t("DashboardPrivateChannels.members.addToChannel")}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        {channels.map((channel) => (
          <DropdownMenuItem key={channel.id} onSelect={() => onPick(channel.id)}>
            {channel.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DisablePrincipalDialog({
  target,
  onClose,
}: {
  target: PrivateChannelPrincipalDto | null;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const t = useTranslations();

  const confirm = () => {
    if (!target) return;
    startTransition(async () => {
      const result = await disablePrincipalAction(target.id);
      if (result.ok) {
        toast.success(t("DashboardPrivateChannels.members.disableSuccess"));
        onClose();
      } else {
        toast.error(result.message);
      }
    });
  };

  return (
    <Modal
      isOpen={target !== null}
      ariaLabel={t("DashboardPrivateChannels.members.disableAria")}
      onClose={pending ? undefined : onClose}
      size="sm"
    >
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-medium tracking-tight text-primary">
            {t("DashboardPrivateChannels.members.disableTitle")}
          </h2>
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.members.disableDescription", {
              name: target?.name ?? "",
            })}
          </p>
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {t("DashboardPrivateChannels.common.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={confirm}
            disabled={pending}
            iconLeft={pending ? <Loader2Icon className="animate-spin" /> : undefined}
          >
            {pending
              ? t("DashboardPrivateChannels.members.disabling")
              : t("DashboardPrivateChannels.members.disable")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
