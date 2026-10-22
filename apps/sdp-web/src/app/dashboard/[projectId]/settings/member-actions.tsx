"use client";

import type { OrganizationRole } from "@sdp/types/roles";
import { Button } from "@sdp/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sdp/ui/dropdown-menu";
import { Modal } from "@sdp/ui/modal";
import { MoreHorizontalIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { changeMemberRole, removeMember } from "@/app/members/actions";
import { useTranslations } from "@/i18n/provider";
import { useActionIdempotencyKey } from "@/lib/use-action-idempotency-key";

export function MemberActions({
  memberId,
  label,
  role,
  isSelf,
  isLastAdmin,
}: {
  memberId: string;
  label: string;
  role: OrganizationRole;
  isSelf: boolean;
  isLastAdmin: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [isConfirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  // One key per change, kept across its retries (a retry after a failed Clerk
  // call finishes the same request) and retired by the answer that settles it.
  const actionKey = useActionIdempotencyKey(null);
  const nextRole = role === "admin" ? "member" : "admin";

  let blockedRoleReason: string | null = null;
  if (isSelf) {
    blockedRoleReason = t("Shared.members.cannotChangeOwnRole");
  } else if (nextRole === "member" && isLastAdmin) {
    blockedRoleReason = t("Shared.members.cannotDemoteLastAdmin");
  }

  const confirmRoleChange = () => {
    const input = JSON.stringify(["role", memberId, nextRole]);
    startTransition(async () => {
      const key = actionKey.keyFor(input);
      const result = await changeMemberRole(memberId, nextRole, key);
      actionKey.settled(input, key, result);
      if (result.status === "error") {
        toast.error(t("Shared.members.roleChangeFailed", { error: result.message }));
        return;
      }
      toast.success(t("Shared.members.roleChanged", { member: label }));
      router.refresh();
    });
  };

  // The API rejects both of these; disabling the row menu means the rule is
  // visible before someone commits to a destructive action rather than after.
  let blockedReason: string | null = null;
  if (isSelf) {
    blockedReason = t("Shared.members.cannotRemoveSelf");
  } else if (isLastAdmin) {
    blockedReason = t("Shared.members.cannotRemoveLastAdmin");
  }

  const confirmRemove = () => {
    const input = JSON.stringify(["remove", memberId]);
    startTransition(async () => {
      const key = actionKey.keyFor(input);
      const result = await removeMember(memberId, key);
      actionKey.settled(input, key, result);

      if (result.status === "error") {
        toast.error(t("Shared.members.removeFailed", { error: result.message }));
        return;
      }

      setConfirmOpen(false);
      toast.success(t("Shared.members.removed", { member: label }));
      router.refresh();
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={isPending}
            aria-label={t("Shared.members.memberActions", { member: label })}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={isPending || Boolean(blockedRoleReason)}
            onSelect={confirmRoleChange}
          >
            {blockedRoleReason ??
              (nextRole === "admin"
                ? t("Shared.members.makeAdmin")
                : t("Shared.members.makeMember"))}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isPending || Boolean(blockedReason)}
            onSelect={() => setConfirmOpen(true)}
          >
            {blockedReason ?? t("Shared.members.removeMember")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Modal
        isOpen={isConfirmOpen}
        ariaLabel={t("Shared.members.removeMember")}
        onClose={() => setConfirmOpen(false)}
        closeDisabled={isPending}
        size="sm"
      >
        <div className="space-y-4 p-6">
          <h2 className="font-medium text-lg text-primary">{t("Shared.members.removeMember")}</h2>
          <p className="text-secondary text-sm">
            {t("Shared.members.removeConfirm", { member: label })}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={isPending}>
              {t("Shared.members.cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmRemove} disabled={isPending}>
              {isPending ? t("Shared.members.removing") : t("Shared.members.removeMember")}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
