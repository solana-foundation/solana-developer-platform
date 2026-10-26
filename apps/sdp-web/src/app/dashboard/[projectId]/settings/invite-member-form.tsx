"use client";

import { ORGANIZATION_ROLES, type OrganizationRole } from "@sdp/types/roles";
import { Button } from "@sdp/ui/button";
import { Input } from "@sdp/ui/input";
import { Select, SelectItem } from "@sdp/ui/select";
import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { type InviteMemberResult, inviteMember } from "@/app/members/actions";
import { useTranslations } from "@/i18n/provider";
import { useActionIdempotencyKey } from "@/lib/use-action-idempotency-key";

type InviteState = InviteMemberResult | null;

const ROLE_LABEL_ID = "invite-role-label";

export function InviteMemberForm() {
  const t = useTranslations();
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
      toast.success(t("Shared.members.inviteSent", { email: state.email }));
      // Clear the field only on success, so a rejected address stays editable.
      formRef.current?.reset();
      setRole("member");
      return;
    }

    toast.error(t("Shared.members.inviteFailed", { error: state.message }));
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
            aria-invalid={state?.status === "error"}
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

        <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
          {isPending ? t("Shared.members.inviteSending") : t("Shared.members.inviteSubmit")}
        </Button>
      </div>
    </form>
  );
}
