"use client";

import { MoreHorizontalIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { removeMember } from "@/app/members/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";

export function MemberActions({
  memberId,
  label,
  isSelf,
  isLastAdmin,
}: {
  memberId: string;
  label: string;
  isSelf: boolean;
  isLastAdmin: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [isConfirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // The API rejects both of these; disabling the row menu means the rule is
  // visible before someone commits to a destructive action rather than after.
  const blockedReason = isSelf
    ? t("Shared.members.cannotRemoveSelf")
    : isLastAdmin
      ? t("Shared.members.cannotRemoveLastAdmin")
      : null;

  const confirmRemove = () => {
    startTransition(async () => {
      const result = await removeMember(memberId);

      if (!result.ok) {
        toast.error(t("Shared.members.removeFailed", { error: result.error }));
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
            aria-label={t("Shared.members.memberActions", { member: label })}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={Boolean(blockedReason)} onSelect={() => setConfirmOpen(true)}>
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
