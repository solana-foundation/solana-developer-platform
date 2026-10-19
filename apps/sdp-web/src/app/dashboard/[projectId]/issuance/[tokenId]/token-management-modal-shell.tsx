"use client";

import { Modal } from "@sdp/ui/modal";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";

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
  const t = useTranslations();
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      closeDisabled={isPending}
      ariaLabel={t("DashboardIssuance.modal.tokenManagementAction")}
      closeLabel={t("DashboardIssuance.modal.close")}
      contentClassName="border-0 bg-transparent shadow-none [&_[data-slot=card-header]]:pr-16"
      size="xl"
    >
      {children}
    </Modal>
  );
}
