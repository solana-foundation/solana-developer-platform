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
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useInvalidateDashboardReads } from "@/lib/dashboard-swr";
import { refreshKeepingDashboardUrl } from "@/lib/dashboard-url-state";
import { fetchResultAnswer, IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import { useActionIdempotencyKey } from "@/lib/use-action-idempotency-key";
import { memberReads } from "./members-query-key";

export function InvitationActions({
  invitationId,
  email,
}: {
  invitationId: string;
  email: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const invalidateReads = useInvalidateDashboardReads();
  const [isPending, startTransition] = useTransition();
  const [isRevoking, setIsRevoking] = useState(false);
  // Kept across retries of one revocation, so a retry finishes its Clerk half.
  const actionKey = useActionIdempotencyKey(null);

  const revoke = () => {
    const input = JSON.stringify(["revoke", invitationId]);
    setIsRevoking(true);
    startTransition(async () => {
      const key = actionKey.keyFor(input);
      const result = await dashboardFetch(
        `/api/dashboard/members/invitations/${encodeURIComponent(invitationId)}`,
        { method: "DELETE", headers: { [IDEMPOTENCY_KEY_HEADER]: key } }
      );
      actionKey.settled(input, key, {
        status: result.ok ? "success" : "error",
        answer: fetchResultAnswer(result),
      });
      setIsRevoking(false);

      if (!result.ok) {
        toast.error(t("Shared.members.revokeFailed", { error: result.error }));
        return;
      }

      toast.success(t("Shared.members.revoked", { email }));
      void invalidateReads(memberReads);
      refreshKeepingDashboardUrl(router);
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
