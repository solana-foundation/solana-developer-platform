"use client";

import { Check, Pencil, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { updateWalletLabelAction } from "./actions";

interface WalletLabelInlineEditorProps {
  canEdit?: boolean;
  walletId: string;
  label: string | null;
}

export function WalletLabelInlineEditor({
  canEdit = true,
  walletId,
  label,
}: WalletLabelInlineEditorProps) {
  const t = useTranslations();
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(label ?? "");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setDraft(label ?? "");
  }, [label]);

  const handleCancel = () => {
    setDraft(label ?? "");
    setIsEditing(false);
  };

  const handleSubmit = () => {
    const toastId = toast.loading(t("DashboardCustody.updatingWalletLabel"), {
      position: "bottom-right",
    });

    startTransition(async () => {
      const result = await updateWalletLabelAction(walletId, draft).catch((error) => ({
        status: "error" as const,
        message: error instanceof Error ? error.message : t("DashboardCustody.unableToUpdateWalletLabel"),
      }));

      if (result.status === "success") {
        toast.success(t("DashboardCustody.walletLabelUpdated"), { id: toastId, position: "bottom-right" });
        setIsEditing(false);
        router.refresh();
        return;
      }

      toast.error(t("DashboardCustody.unableToUpdateWalletLabel"), {
        id: toastId,
        description: result.message,
        position: "bottom-right",
      });
    });
  };

  if (isEditing) {
    return (
      <div className="flex min-w-0 max-w-full items-center gap-1">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={100}
          placeholder={t("DashboardCustody.untitled")}
          className="h-8 min-w-0 w-full"
          disabled={isPending}
          autoFocus
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleSubmit();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              handleCancel();
            }
          }}
        />
        <Button
          type="button"
          size="icon-xs"
          onClick={handleSubmit}
          disabled={isPending}
          aria-label={t("DashboardCustody.saveWalletLabel")}
          title={t("DashboardCustody.saveWalletLabel")}
        >
          <Check className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={handleCancel}
          disabled={isPending}
          aria-label={t("DashboardCustody.cancelWalletLabelEdit")}
          title={t("DashboardCustody.cancelWalletLabelEdit")}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="group flex min-w-0 items-center gap-1">
      <div className="min-w-0 truncate" title={label ?? t("DashboardCustody.untitled")}>
        {label ?? t("DashboardCustody.untitled")}
      </div>
      {canEdit ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => setIsEditing(true)}
          aria-label={t("DashboardCustody.editWalletLabel")}
          title={t("DashboardCustody.editWalletLabel")}
          className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        >
          <Pencil className="h-3 w-3" />
        </Button>
      ) : null}
    </div>
  );
}
