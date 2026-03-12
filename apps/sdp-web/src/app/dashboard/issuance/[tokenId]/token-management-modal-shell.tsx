"use client";

import { useEscapeKey } from "@/lib/use-escape-key";
import type { ReactNode } from "react";

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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(18,18,19,0.44)] p-4">
      <button
        type="button"
        aria-label="Close modal"
        className="absolute inset-0"
        onClick={onClose}
        disabled={isPending}
      />
      <div className="relative z-10 w-full max-w-2xl">{children}</div>
    </div>
  );
}
