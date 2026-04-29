"use client";

import { Check, Pencil, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    const toastId = toast.loading("Updating wallet label.", {
      position: "bottom-right",
    });

    startTransition(async () => {
      const result = await updateWalletLabelAction(walletId, draft).catch((error) => ({
        status: "error" as const,
        message: error instanceof Error ? error.message : "Unable to update wallet label.",
      }));

      if (result.status === "success") {
        toast.success("Wallet label updated.", { id: toastId, position: "bottom-right" });
        setIsEditing(false);
        router.refresh();
        return;
      }

      toast.error("Unable to update wallet label.", {
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
          placeholder="Untitled"
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
          aria-label="Save wallet label"
          title="Save wallet label"
        >
          <Check className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={handleCancel}
          disabled={isPending}
          aria-label="Cancel wallet label edit"
          title="Cancel wallet label edit"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="group flex min-w-0 items-center gap-1">
      <div className="min-w-0 truncate" title={label ?? "Untitled"}>
        {label ?? "Untitled"}
      </div>
      {canEdit ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => setIsEditing(true)}
          aria-label="Edit wallet label"
          title="Edit wallet label"
          className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        >
          <Pencil className="h-3 w-3" />
        </Button>
      ) : null}
    </div>
  );
}
