"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { type InviteMemberResult, inviteMember } from "@/app/members/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";

type InviteState = InviteMemberResult | null;

const ROLE_LABEL_ID = "invite-role-label";

async function submitInvite(_previous: InviteState, formData: FormData): Promise<InviteState> {
  return inviteMember(formData);
}

export function InviteMemberForm() {
  const t = useTranslations();
  const [state, formAction, isPending] = useActionState<InviteState, FormData>(submitInvite, null);
  const [role, setRole] = useState<"admin" | "member">("member");
  const formRef = useRef<HTMLFormElement>(null);
  // useActionState keeps the last result, so react to identity changes rather
  // than value: two failures with the same message must still both surface.
  const reportedState = useRef<InviteState>(null);

  useEffect(() => {
    if (!state || state === reportedState.current) {
      return;
    }
    reportedState.current = state;

    if (state.ok) {
      toast.success(t("Shared.members.inviteSent", { email: state.email }));
      // Clear the field only on success, so a rejected address stays editable.
      formRef.current?.reset();
      setRole("member");
      return;
    }

    toast.error(t("Shared.members.inviteFailed", { error: state.error }));
  }, [state, t]);

  return (
    // Grid rather than a flex row: the status message needs a full-width row of
    // its own, and as a flex child it collapsed the email field to nothing and
    // stacked the two captions on top of each other.
    <form ref={formRef} action={formAction} className="space-y-3">
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto]">
        <div className="min-w-0">
          <label htmlFor="invite-email" className="mb-2 block font-medium text-primary text-sm">
            {t("Shared.members.inviteEmail")}
          </label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder={t("Shared.members.inviteEmailPlaceholder")}
            aria-invalid={state?.ok === false}
          />
        </div>

        <div className="min-w-0">
          <span id={ROLE_LABEL_ID} className="mb-2 block font-medium text-primary text-sm">
            {t("Shared.members.inviteRole")}
          </span>
          {/* The design-system Select is controlled and renders no native form
              control, so the value is mirrored into a hidden input to reach the
              server action's FormData. */}
          <input type="hidden" name="role" value={role} />
          <Select
            ariaLabel={t("Shared.members.inviteRole")}
            value={role}
            onValueChange={(next) => setRole(next === "admin" ? "admin" : "member")}
          >
            <SelectItem value="member">{t("Shared.members.roleMember")}</SelectItem>
            <SelectItem value="admin">{t("Shared.members.roleAdmin")}</SelectItem>
          </Select>
        </div>

        <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
          {isPending ? t("Shared.members.inviteSending") : t("Shared.members.inviteSubmit")}
        </Button>
      </div>
    </form>
  );
}
