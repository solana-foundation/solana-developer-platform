"use client";

import { ORGANIZATION_ROLES, type OrganizationRole } from "@sdp/types/roles";
import { Button } from "@sdp/ui/button";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Select, SelectItem } from "@sdp/ui/select";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { type InviteMemberResult, inviteMember } from "@/app/(session)/members/actions";
import { useTranslations } from "@/i18n/provider";
import { refreshKeepingDashboardUrl } from "@/lib/dashboard-url-state";
import { useActionIdempotencyKey } from "@/lib/use-action-idempotency-key";

type InviteState = InviteMemberResult | null;

const ROLE_LABEL_ID = "invite-role-label";

export function InviteMemberForm() {
  const t = useTranslations();
  const router = useRouter();
  // One key per address and role sent, kept across retries of them and
  // retired by the answer that settles it; editing either is a new key.
  const actionKey = useActionIdempotencyKey(null);
  const submitInvite = async (_previous: InviteState, formData: FormData): Promise<InviteState> => {
    const input = JSON.stringify([
      "invite",
      String(formData.get("email")).trim().toLowerCase(),
      String(formData.get("role")),
    ]);
    const key = actionKey.keyFor(input);
    formData.set("idempotencyKey", key);
    const result = await inviteMember(formData);
    actionKey.settled(input, key, result);
    return result;
  };
  const [state, formAction, isPending] = useActionState<InviteState, FormData>(submitInvite, null);
  const [role, setRole] = useState<OrganizationRole>("member");
  const formRef = useRef<HTMLFormElement>(null);
  // useActionState keeps the last result, so react to identity changes rather
  // than value: two failures with the same message must still both surface.
  const reportedState = useRef<InviteState>(null);

  useEffect(() => {
    if (!state || state === reportedState.current) {
      return;
    }
    reportedState.current = state;

    if (state.status === "success") {
      toast.success(
        state.emailSent
          ? t("Shared.members.inviteSent", { email: state.email })
          : t("Shared.members.inviteGranted", { email: state.email })
      );
      // Clear the field only on success, so a rejected address stays editable.
      formRef.current?.reset();
      setRole("member");
      refreshKeepingDashboardUrl(router);
      return;
    }

    // A server error's text is not the user's to act on, so only a refusal's
    // message is shown; an outage or a provider failure gets the generic line.
    const status = state.answer?.status;
    const refused = status === undefined || (status !== null && status < 500);
    toast.error(
      refused
        ? t("Shared.members.inviteFailed", { error: state.message })
        : t("Shared.members.inviteFailedUnexpectedly")
    );
  }, [state, t, router]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-col gap-3 @xl:flex-row @xl:items-end"
    >
      <div className="flex min-w-0 flex-col gap-1.5 @xl:flex-1">
        <Label htmlFor="invite-email">{t("Shared.members.inviteEmail")}</Label>
        <Input
          id="invite-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder={t("Shared.members.inviteEmailPlaceholder")}
          aria-invalid={state?.status === "error"}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-1.5 @xl:w-44">
        <span id={ROLE_LABEL_ID} className="text-meta leading-none text-secondary">
          {t("Shared.members.inviteRole")}
        </span>
        {/* The design-system Select is controlled and renders no native form
            control, so the value is mirrored into a hidden input to reach the
            server action's FormData. */}
        <input type="hidden" name="role" value={role} />
        <Select
          ariaLabel={t("Shared.members.inviteRole")}
          value={role}
          onValueChange={(next) => {
            // Only the options above can be chosen; anything else leaves the choice as it was.
            const picked = ORGANIZATION_ROLES.find((candidate) => candidate === next);
            if (picked) setRole(picked);
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
