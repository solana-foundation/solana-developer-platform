"use client";

import type { ReactNode } from "react";
import { ModalCloseButton } from "@/components/ui/modal-close-button";
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
          tabIndex={-1}
        />
        <div className="pointer-events-none relative flex min-h-full items-center justify-center p-4">
          <div className="pointer-events-auto relative z-10 w-full max-w-2xl [&_[data-slot=card-header]]:pr-16">
            <ModalCloseButton onClick={onClose} disabled={isPending} label="Close modal" />
            {children}
          </div>
        </div>
      </div>
    </TokenModalPortal>
  );
}
