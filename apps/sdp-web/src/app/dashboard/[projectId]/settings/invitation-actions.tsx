"use client";

import { Button } from "@sdp/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sdp/ui/dropdown-menu";
import { MoreHorizontalIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { revokeInvitation } from "@/app/members/actions";
import { useTranslations } from "@/i18n/provider";
import { useActionIdempotencyKey } from "@/lib/use-action-idempotency-key";

export function InvitationActions({
  invitationId,
  email,
}: {
  invitationId: string;
  email: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isRevoking, setIsRevoking] = useState(false);
  // Kept across retries of one revocation, so a retry finishes its Clerk half.
  const actionKey = useActionIdempotencyKey(null);

  const revoke = () => {
    const input = JSON.stringify(["revoke", invitationId]);
    setIsRevoking(true);
    startTransition(async () => {
      const key = actionKey.keyFor(input);
      const result = await revokeInvitation(invitationId, key);
      actionKey.settled(input, key, result);
      setIsRevoking(false);

      if (result.status === "error") {
        toast.error(t("Shared.members.revokeFailed", { error: result.message }));
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
        <DropdownMenuItem onSelect={revoke}>
          {isRevoking ? t("Shared.members.revoking") : t("Shared.members.revokeInvite")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
