"use client";

import { useClerk } from "@clerk/nextjs";
import { Button } from "@sdp/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { Modal } from "@sdp/ui/modal";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { leaveOrganization } from "@/app/members/actions";
import { useTranslations } from "@/i18n/provider";

/**
 * Lets a member end their own membership. Admins cannot leave (the API refuses
 * it), so the settings page renders this for members only. Once it commits the
 * API refuses the person, so the session drops the organization and returns
 * to the organization picker.
 */
export function LeaveOrganizationCard() {
  const t = useTranslations();
  const router = useRouter();
  const { setActive } = useClerk();
  const [isConfirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const confirmLeave = () => {
    startTransition(async () => {
      const result = await leaveOrganization();
      if (result.status === "error") {
        // The membership may have ended before the request failed (its Clerk
        // half runs after the commit): refreshing lets the layout's own check
        // show the no-access panel if it did.
        toast.error(t("Shared.members.leaveFailed", { error: result.message }));
        router.refresh();
        return;
      }
      try {
        await setActive({ organization: null });
      } catch (error) {
        toast.error(t("Shared.members.leaveFailed", { error: String(error) }));
      }
      router.push("/dashboard");
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Shared.members.leaveTitle")}</CardTitle>
        <CardDescription>{t("Shared.members.leaveDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setConfirmOpen(true)} disabled={isPending}>
          {t("Shared.members.leaveOrganization")}
        </Button>
      </CardContent>
      <Modal
        isOpen={isConfirmOpen}
        ariaLabel={t("Shared.members.leaveOrganization")}
        onClose={() => setConfirmOpen(false)}
        closeDisabled={isPending}
        size="sm"
      >
        <div className="space-y-4 p-6">
          <h2 className="font-medium text-lg text-primary">
            {t("Shared.members.leaveOrganization")}
          </h2>
          <p className="text-secondary text-sm">{t("Shared.members.leaveConfirm")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={isPending}>
              {t("Shared.members.cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmLeave} disabled={isPending}>
              {isPending ? t("Shared.members.leaving") : t("Shared.members.leaveOrganization")}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
