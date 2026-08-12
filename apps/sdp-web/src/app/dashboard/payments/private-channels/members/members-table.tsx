"use client";

import type {
  ListProjectMembersResponse,
  PrivateChannelDto,
  PrivateChannelUserDto,
} from "@sdp/types";
import { Loader2Icon, PlusIcon, Trash2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  addToChannelAction,
  deleteMemberAction,
  inviteMemberAction,
  removeFromChannelAction,
} from "./actions";

type ProjectMember = ListProjectMembersResponse["members"][number];

interface Props {
  members: PrivateChannelUserDto[];
  channels: PrivateChannelDto[];
  eligibleProjectMembers: ProjectMember[];
}

export function MembersTable({ members, channels, eligibleProjectMembers }: Props) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PrivateChannelUserDto | null>(null);
  const t = useTranslations();

  const invitedUserIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);
  const eligibleForInvite = useMemo(
    () => eligibleProjectMembers.filter((pm) => !invitedUserIds.has(pm.userId)),
    [eligibleProjectMembers, invitedUserIds]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-secondary">
          {members.length === 1
            ? t("DashboardPrivateChannels.members.countOne", { count: members.length })
            : t("DashboardPrivateChannels.members.countOther", { count: members.length })}
        </p>
        <Button onClick={() => setInviteOpen(true)} disabled={eligibleForInvite.length === 0}>
          {t("DashboardPrivateChannels.members.inviteMember")}
        </Button>
      </div>

      {members.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-default p-8 text-center text-sm text-secondary">
          {t("DashboardPrivateChannels.members.empty")}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("DashboardPrivateChannels.members.columnEmail")}</TableHead>
              <TableHead>{t("DashboardPrivateChannels.members.columnRole")}</TableHead>
              <TableHead>{t("DashboardPrivateChannels.members.columnVerifiedWallets")}</TableHead>
              <TableHead>{t("DashboardPrivateChannels.members.columnChannels")}</TableHead>
              <TableHead className="text-right">
                {t("DashboardPrivateChannels.members.columnActions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                allChannels={channels}
                onDelete={() => setDeleteTarget(m)}
              />
            ))}
          </TableBody>
        </Table>
      )}

      <InviteDialog
        isOpen={inviteOpen}
        onClose={() => setInviteOpen(false)}
        candidates={eligibleForInvite}
      />

      <DeleteMemberDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </div>
  );
}

function MemberRow({
  member,
  allChannels,
  onDelete,
}: {
  member: PrivateChannelUserDto;
  allChannels: PrivateChannelDto[];
  onDelete: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const t = useTranslations();
  const inChannelIds = new Set(member.channels.map((c) => c.id));
  const notInChannels = allChannels.filter((c) => !inChannelIds.has(c.id));

  const removeFromChannel = (channelId: string) => {
    startTransition(async () => {
      const res = await removeFromChannelAction(channelId, member.id);
      if (!res.ok) toast.error(res.message);
    });
  };

  const addToChannel = (channelId: string) => {
    startTransition(async () => {
      const res = await addToChannelAction(channelId, member.id);
      if (!res.ok) toast.error(res.message);
    });
  };

  return (
    <TableRow>
      <TableCell className="break-all text-sm">{member.email}</TableCell>
      <TableCell className="text-sm">
        {member.projectRole ? (
          <span className="capitalize">{member.projectRole}</span>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 text-destructive-strong">
                <TriangleAlertIcon className="size-4" aria-hidden />
                <span aria-hidden>—</span>
                <span className="sr-only">
                  {t("DashboardPrivateChannels.members.roleRevokedTooltip")}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("DashboardPrivateChannels.members.roleRevokedTooltip")}
            </TooltipContent>
          </Tooltip>
        )}
      </TableCell>
      <TableCell>
        <WalletCountBadge count={member.verifiedWalletCount} />
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          {member.channels.map((c) => (
            <ChannelChip
              key={c.id}
              label={
                c.name +
                (c.isDefault ? ` ${t("DashboardPrivateChannels.members.defaultSuffix")}` : "")
              }
              onRemove={pending ? undefined : () => removeFromChannel(c.id)}
            />
          ))}
          {notInChannels.length > 0 ? (
            <AddToChannelMenu channels={notInChannels} disabled={pending} onPick={addToChannel} />
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          disabled={pending}
          aria-label={t("DashboardPrivateChannels.members.delete")}
          title={t("DashboardPrivateChannels.members.delete")}
        >
          <Trash2Icon />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function WalletCountBadge({ count }: { count: number }) {
  const hasWallets = count > 0;
  const t = useTranslations();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm",
        hasWallets ? "text-status-success-text" : "text-secondary"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-2 rounded-full",
          hasWallets ? "bg-status-success-text" : "bg-fill"
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
  // Uses the design system's DropdownMenu (Radix) so the menu portals to the
  // document body and isn't clipped by the table's overflow container.
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
        {channels.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => onPick(c.id)}>
            {c.name}
            {c.isDefault ? (
              <span className="ml-1 text-secondary">
                {t("DashboardPrivateChannels.members.defaultSuffix")}
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InviteDialog({
  isOpen,
  onClose,
  candidates,
}: {
  isOpen: boolean;
  onClose: () => void;
  candidates: ProjectMember[];
}) {
  const [userId, setUserId] = useState("");
  const [pending, startTransition] = useTransition();
  const t = useTranslations();

  const submit = () => {
    if (!userId) return;
    startTransition(async () => {
      const res = await inviteMemberAction(userId);
      if (res.ok) {
        toast.success(
          t("DashboardPrivateChannels.members.inviteSuccess", { email: res.value.user.email })
        );
        if (res.value.inviteUrl) {
          navigator.clipboard?.writeText(res.value.inviteUrl).catch(() => {});
          toast.info(t("DashboardPrivateChannels.members.inviteUrlCopied"));
        }
        setUserId("");
        onClose();
      } else {
        toast.error(res.message);
      }
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      ariaLabel={t("DashboardPrivateChannels.members.inviteAria")}
      onClose={pending ? undefined : onClose}
      size="sm"
    >
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-medium tracking-tight text-primary">
            {t("DashboardPrivateChannels.members.inviteTitle")}
          </h2>
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.members.inviteDescription")}
          </p>
        </div>
        <div className="grid gap-2">
          <label htmlFor="invite-user" className="text-sm font-medium text-primary">
            {t("DashboardPrivateChannels.members.projectUser")}
          </label>
          <select
            id="invite-user"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            disabled={pending}
            className="w-full truncate rounded-md border border-border-default bg-surface px-3 py-2 pr-8 text-sm text-primary"
          >
            <option value="">{t("DashboardPrivateChannels.members.selectUser")}</option>
            {candidates.map((pm) => (
              <option key={pm.userId} value={pm.userId} title={pm.user.name ?? pm.user.email}>
                {pm.user.email}
              </option>
            ))}
          </select>
          {(() => {
            const picked = candidates.find((pm) => pm.userId === userId);
            return picked?.user.name ? (
              <p className="truncate text-xs text-secondary">
                {t("DashboardPrivateChannels.members.pickedName", { name: picked.user.name })}
              </p>
            ) : null;
          })()}
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {t("DashboardPrivateChannels.common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={!userId || pending}
            iconLeft={pending ? <Loader2Icon className="animate-spin" /> : undefined}
          >
            {pending
              ? t("DashboardPrivateChannels.members.inviting")
              : t("DashboardPrivateChannels.members.invite")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteMemberDialog({
  target,
  onClose,
}: {
  target: PrivateChannelUserDto | null;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const t = useTranslations();
  const isOpen = target !== null;

  const confirm = () => {
    if (!target) return;
    startTransition(async () => {
      const res = await deleteMemberAction(target.id);
      if (res.ok) {
        toast.success(t("DashboardPrivateChannels.members.removeSuccess"));
        onClose();
      } else {
        toast.error(res.message);
      }
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      ariaLabel={t("DashboardPrivateChannels.members.deleteAria")}
      onClose={pending ? undefined : onClose}
      size="sm"
    >
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-medium tracking-tight text-primary">
            {t("DashboardPrivateChannels.members.removeTitle")}
          </h2>
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.members.removeDescription", {
              email: target?.email ?? "",
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
              ? t("DashboardPrivateChannels.members.removing")
              : t("DashboardPrivateChannels.members.remove")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
