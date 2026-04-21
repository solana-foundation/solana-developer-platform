"use client";

import type { ReactNode } from "react";
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
          className="absolute inset-0"
          onClick={onClose}
          disabled={isPending}
        />
        <div className="relative flex min-h-full items-center justify-center p-4">
          <div className="relative z-10 w-full max-w-2xl">{children}</div>
        </div>
      </div>
    </TokenModalPortal>
  );
}
