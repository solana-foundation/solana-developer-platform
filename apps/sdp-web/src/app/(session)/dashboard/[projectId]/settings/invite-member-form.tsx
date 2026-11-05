"use client";

import { ORGANIZATION_ROLES } from "@sdp/types/roles";
import { Button } from "@sdp/ui/button";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Select, SelectItem } from "@sdp/ui/select";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useInvalidateDashboardReads } from "@/lib/dashboard-swr";
import { refreshKeepingDashboardUrl } from "@/lib/dashboard-url-state";
import { fetchResultAnswer, IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import { useActionIdempotencyKey } from "@/lib/use-action-idempotency-key";
import { useZodForm } from "@/lib/use-zod-form";
import { memberReads } from "./members-query-key";

const ROLE_LABEL_ID = "invite-role-label";

const createdInvitationSchema = z.object({
  data: z.object({ invitation: z.object({ clerkInvitationId: z.string().nullable() }) }),
});

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().min(1),
  role: z.enum(ORGANIZATION_ROLES),
});

export function InviteMemberForm() {
  const t = useTranslations();
  const router = useRouter();
  const invalidateReads = useInvalidateDashboardReads();
  // One key per address and role sent, kept across retries of them and
  // retired by the answer that settles it; editing either is a new key.
  const actionKey = useActionIdempotencyKey(null);
  const form = useZodForm(inviteSchema, { email: "", role: "member" });
  const [isRejected, setRejected] = useState(false);
  const [isPending, startTransition] = useTransition();

  const submitInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = form.validate();
    if (!parsed.ok) {
      setRejected(true);
      toast.error(t("Shared.members.inviteFailed", { error: t("Shared.members.emailRequired") }));
      return;
    }
    const invite = parsed.data;
    const input = JSON.stringify(["invite", invite.email, invite.role]);
    startTransition(async () => {
      const key = actionKey.keyFor(input);
      const result = await dashboardFetch("/api/dashboard/members/invite", {
        method: "POST",
        headers: { [IDEMPOTENCY_KEY_HEADER]: key },
        body: invite,
      });
      actionKey.settled(input, key, {
        status: result.ok ? "success" : "error",
        answer: fetchResultAnswer(result),
      });
      if (!result.ok) {
        setRejected(true);
        // A server error's text is not the user's to act on, so only a refusal's
        // message is shown; an outage or a provider failure gets the generic line.
        const refused = result.status !== null && result.status < 500;
        toast.error(
          refused
            ? t("Shared.members.inviteFailed", { error: result.error })
            : t("Shared.members.inviteFailedUnexpectedly")
        );
        return;
      }
      setRejected(false);
      // A null Clerk invitation id means the address already held the organization in Clerk:
      // the SDP invitation admits them and no email went out. An unreadable body fails loudly
      // rather than guessing.
      const emailSent =
        createdInvitationSchema.parse(result.data).data.invitation.clerkInvitationId !== null;
      toast.success(
        emailSent
          ? t("Shared.members.inviteSent", { email: invite.email })
          : t("Shared.members.inviteGranted", { email: invite.email })
      );
      // Clear the field only on success, so a rejected address stays editable.
      form.reset();
      void invalidateReads(memberReads);
      refreshKeepingDashboardUrl(router);
    });
  };

  return (
    <form onSubmit={submitInvite} className="flex flex-col gap-3 @xl:flex-row @xl:items-end">
      <div className="flex min-w-0 flex-col gap-1.5 @xl:flex-1">
        <Label htmlFor="invite-email">{t("Shared.members.inviteEmail")}</Label>
        <Input
          id="invite-email"
          type="email"
          value={form.values.email}
          onChange={(event) => {
            form.setField("email", event.target.value);
            setRejected(false);
          }}
          autoComplete="email"
          placeholder={t("Shared.members.inviteEmailPlaceholder")}
          aria-invalid={isRejected || form.errors.email !== undefined}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-1.5 @xl:w-44">
        <span id={ROLE_LABEL_ID} className="text-meta leading-none text-secondary">
          {t("Shared.members.inviteRole")}
        </span>
        <Select
          ariaLabel={t("Shared.members.inviteRole")}
          value={form.values.role}
          onValueChange={(next) => {
            // Only the options above can be chosen; anything else leaves the choice as it was.
            const picked = ORGANIZATION_ROLES.find((candidate) => candidate === next);
            if (picked) form.setField("role", picked);
          }}
        >
          <SelectItem value="member">{t("Shared.members.roleMember")}</SelectItem>
          <SelectItem value="viewer">{t("Shared.members.roleViewer")}</SelectItem>
          <SelectItem value="admin">{t("Shared.members.roleAdmin")}</SelectItem>
        </Select>
      </div>

      <Button type="submit" size="sm" loading={isPending} className="self-start @xl:self-auto">
        {t("Shared.members.inviteSubmit")}
      </Button>
    </form>
  );
}
