"use client";

import type { ReactNode } from "react";
import { Modal } from "@/components/ui/modal";

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
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      closeDisabled={isPending}
      ariaLabel="Token management action"
      closeLabel="Close modal"
      contentClassName="border-0 bg-transparent shadow-none [&_[data-slot=card-header]]:pr-16"
      size="xl"
    >
      {children}
    </Modal>
  );
}
