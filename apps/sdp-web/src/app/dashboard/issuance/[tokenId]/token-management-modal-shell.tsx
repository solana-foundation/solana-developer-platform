"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useEscapeKey } from "@/lib/use-escape-key";
import { TokenModalPortal } from "./token-modal-portal";

interface TokenManagementModalShellProps {
  isOpen: boolean;
  isPending: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function TokenManagementModalShell({
  isOpen,
  isPending,
  onClose,
  children,
}: TokenManagementModalShellProps) {
  useEscapeKey(isOpen && !isPending, onClose);

  if (!isOpen) {
    return null;
  }

  return (
    <TokenModalPortal>
      <div className="fixed inset-0 z-40 overflow-y-auto bg-[rgba(18,18,19,0.44)]">
        <button
          type="button"
          aria-label="Close modal"
          className="absolute inset-0 cursor-default"
          onClick={onClose}
          disabled={isPending}
        />
        <div className="pointer-events-none relative flex min-h-full items-center justify-center p-4">
          <div className="pointer-events-auto relative z-10 flex w-full max-w-2xl flex-col items-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              disabled={isPending}
              aria-label="Close modal"
              className="rounded-full bg-white/90 text-[rgba(28,28,29,0.72)] shadow-sm hover:bg-[rgba(28,28,29,0.08)] hover:text-[#1c1c1d]"
            >
              <X className="h-4 w-4" />
            </Button>
            <div className="w-full">{children}</div>
          </div>
        </div>
      </div>
    </TokenModalPortal>
  );
}
