"use client";

import { MoreHorizontalIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { revokeInvitation } from "@/app/members/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "@/i18n/provider";

export function InvitationActions({
  invitationId,
  email,
  acceptUrl,
}: {
  invitationId: string;
  email: string;
  acceptUrl: string | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isRevoking, setIsRevoking] = useState(false);

  const copyLink = async () => {
    if (!acceptUrl) return;

    try {
      await navigator.clipboard.writeText(acceptUrl);
      toast.success(t("Shared.members.inviteLinkCopied"));
    } catch {
      // Clipboard access is refused on insecure origins and when the document
      // is not focused, so say so rather than appearing to do nothing.
      toast.error(t("Shared.members.inviteLinkCopyFailed"));
    }
  };

  const revoke = () => {
    setIsRevoking(true);
    startTransition(async () => {
      const result = await revokeInvitation(invitationId);
      setIsRevoking(false);

      if (!result.ok) {
        toast.error(t("Shared.members.revokeFailed", { error: result.error }));
        return;
      }

      toast.success(t("Shared.members.revoked", { email }));
      router.refresh();
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={isPending || isRevoking}
          aria-label={t("Shared.members.invitationActions", { email })}
        >
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Absent when Clerk could not be reached; offering a copy action that
            silently copies nothing would be worse than hiding it. */}
        {acceptUrl ? (
          <DropdownMenuItem onSelect={() => void copyLink()}>
            {t("Shared.members.copyInviteLink")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={revoke}>
          {isRevoking ? t("Shared.members.revoking") : t("Shared.members.revokeInvite")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
