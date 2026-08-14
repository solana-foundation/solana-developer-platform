"use client";

import { PencilIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { updateWalletLabelAction } from "./actions";

interface WalletLabelInlineEditorProps {
  canEdit?: boolean;
  emptyLabel?: string;
  walletId: string;
  label: string | null;
}

export function WalletLabelInlineEditor({
  canEdit = true,
  emptyLabel,
  walletId,
  label,
}: WalletLabelInlineEditorProps) {
  const t = useTranslations();
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(label ?? "");
  const [isPending, startTransition] = useTransition();
  const displayLabel = label ?? emptyLabel ?? t("DashboardCustody.untitled");

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
        message:
          error instanceof Error ? error.message : t("DashboardCustody.unableToUpdateWalletLabel"),
      }));

      if (result.status === "success") {
        toast.success(t("DashboardCustody.walletLabelUpdated"), {
          id: toastId,
          position: "bottom-right",
        });
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
      <div className="flex min-w-0 max-w-full items-center gap-1 border-b border-border-strong pb-1 focus-within:border-[var(--input-border-focus)]">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={100}
          placeholder={t("DashboardCustody.untitled")}
          className="w-full min-w-0 border-0 bg-transparent p-0 text-primary placeholder:text-tertiary focus:outline-none disabled:opacity-50"
          style={{ font: "inherit", letterSpacing: "inherit" }}
          disabled={isPending}
          // biome-ignore lint/a11y/noAutofocus: editing starts from an explicit user action, so focus moving into the field is the expected behavior.
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
        <Button type="button" size="xs" onClick={handleSubmit} disabled={isPending}>
          {t("DashboardCustody.save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={handleCancel}
          disabled={isPending}
        >
          {t("DashboardCustody.cancel")}
        </Button>
      </div>
    );
  }

  return (
    <div className="group flex min-w-0 items-center gap-1">
      <div className="min-w-0 truncate" title={displayLabel}>
        {displayLabel}
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
          <PencilIcon className="h-3 w-3" />
        </Button>
      ) : null}
    </div>
  );
}
