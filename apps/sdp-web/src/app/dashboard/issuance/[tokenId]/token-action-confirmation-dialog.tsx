"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEscapeKey } from "@/lib/use-escape-key";
import type { ActionConfirmationState } from "./token-management-workspace.types";
import { TokenModalPortal } from "./token-modal-portal";

interface TokenActionConfirmationDialogProps {
  actionConfirmation: ActionConfirmationState | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TokenActionConfirmationDialog({
  actionConfirmation,
  isPending,
  onCancel,
  onConfirm,
}: TokenActionConfirmationDialogProps) {
  useEscapeKey(Boolean(actionConfirmation) && !isPending, onCancel);

  if (!actionConfirmation) {
    return null;
  }

  return (
    <TokenModalPortal>
      <div className="fixed inset-0 z-40 overflow-y-auto bg-[rgba(18,18,19,0.44)]">
        <button
          type="button"
          aria-label="Close confirmation modal"
          className="absolute inset-0 cursor-default"
          onClick={onCancel}
          disabled={isPending}
          tabIndex={-1}
        />
        <div className="pointer-events-none relative flex min-h-full items-center justify-center p-4">
          <div className="pointer-events-auto relative w-full max-w-md rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onCancel}
              disabled={isPending}
              aria-label="Close confirmation modal"
              className="absolute top-3 right-3 rounded-full text-[rgba(28,28,29,0.72)] hover:bg-[rgba(28,28,29,0.08)] hover:text-[#1c1c1d]"
            >
              <X className="h-4 w-4" />
            </Button>
            <h4 className="pr-10 text-[22px] leading-[1.2] font-medium text-[#1c1c1d]">
              {actionConfirmation.options.confirmationTitle}
            </h4>
            <p className="mt-2 text-[15px] leading-[1.45] text-[rgba(28,28,29,0.72)]">
              {actionConfirmation.options.confirmationDescription}
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
                Not now
              </Button>
              <Button type="button" onClick={onConfirm} disabled={isPending}>
                {actionConfirmation.options.confirmButtonLabel}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </TokenModalPortal>
  );
}
