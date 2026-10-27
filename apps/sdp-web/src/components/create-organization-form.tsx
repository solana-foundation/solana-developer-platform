"use client";

import { useClerk } from "@clerk/nextjs";
import { Button } from "@sdp/ui/button";
import { Input } from "@sdp/ui/input";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createOrganization } from "@/app/dashboard/create-organization-actions";
import { useTranslations } from "@/i18n/provider";

/**
 * The "Name your organization" step for a signed-in person with no
 * organization and no invitation: SDP creates it and makes them its admin,
 * then the session switches to it.
 */
export function CreateOrganizationForm() {
  const t = useTranslations();
  const router = useRouter();
  const clerk = useClerk();
  const [name, setName] = useState("");
  const [isPending, startTransition] = useTransition();
  const trimmedName = name.trim();

  const submit = () => {
    startTransition(async () => {
      // SDP refuses a session whose active organization it links. Clearing it
      // is best effort: with personal accounts off, Clerk keeps an
      // organization active, and the API allows one SDP never linked.
      if (clerk.organization) {
        await clerk.setActive({ organization: null });
      }
      const result = await createOrganization(trimmedName);
      if (!result.ok) {
        toast.error(t("Shared.SharedComponents.createOrganizationFailed", { error: result.error }));
        return;
      }
      await clerk.setActive({ organization: result.clerkOrganizationId });
      router.refresh();
    });
  };

  return (
    <form
      className="mt-6 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor="organization-name" className="block font-medium text-primary text-sm">
        {t("Shared.SharedComponents.organizationNameLabel")}
      </label>
      <Input
        id="organization-name"
        name="name"
        value={name}
        maxLength={100}
        autoComplete="organization"
        placeholder={t("Shared.SharedComponents.organizationNamePlaceholder")}
        disabled={isPending}
        onChange={(event) => setName(event.target.value)}
      />
      <Button type="submit" className="w-full" disabled={isPending || trimmedName.length === 0}>
        {isPending
          ? t("Shared.SharedComponents.creatingOrganization")
          : t("Shared.SharedComponents.createOrganizationSubmit")}
      </Button>
    </form>
  );
}
