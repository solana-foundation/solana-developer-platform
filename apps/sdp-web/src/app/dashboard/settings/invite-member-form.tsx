"use client";

import { useActionState, useState } from "react";
import { type InviteMemberResult, inviteMember } from "@/app/members/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";

type InviteState = InviteMemberResult | null;

async function submitInvite(_previous: InviteState, formData: FormData): Promise<InviteState> {
  return inviteMember(formData);
}

export function InviteMemberForm() {
  const t = useTranslations();
  const [state, formAction, isPending] = useActionState<InviteState, FormData>(submitInvite, null);
  const [role, setRole] = useState<"admin" | "member">("member");

  return (
    <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <label htmlFor="invite-email" className="block min-w-0 flex-1">
        <span className="mb-2 block font-medium text-primary text-sm">
          {t("Shared.members.inviteEmail")}
        </span>
        <Input
          id="invite-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder={t("Shared.members.inviteEmailPlaceholder")}
          aria-invalid={state?.ok === false}
        />
      </label>

      <div className="sm:w-44">
        <span className="mb-2 block font-medium text-primary text-sm">
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

      <Button type="submit" disabled={isPending} className="shrink-0">
        {isPending ? t("Shared.members.inviteSending") : t("Shared.members.inviteSubmit")}
      </Button>

      {state ? (
        <p
          role="status"
          className={
            state.ok ? "text-sm text-success sm:basis-full" : "text-error text-sm sm:basis-full"
          }
        >
          {state.ok
            ? t("Shared.members.inviteSent", { email: state.email })
            : t("Shared.members.inviteFailed", { error: state.error })}
        </p>
      ) : null}
    </form>
  );
}
