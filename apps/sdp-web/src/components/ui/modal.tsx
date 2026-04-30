"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "@/lib/use-escape-key";
import { cn } from "@/lib/utils";
import { ModalCloseButton } from "./modal-close-button";

type ModalSize = "sm" | "md" | "lg" | "xl";

interface ModalProps {
  isOpen: boolean;
  ariaLabel: string;
  children: ReactNode;
  onClose?: () => void;
  closeDisabled?: boolean;
  closeLabel?: string;
  contentClassName?: string;
  showCloseButton?: boolean;
  size?: ModalSize;
}

const sizeClassNames: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-xl",
  xl: "max-w-2xl",
};

export function Modal({
  isOpen,
  ariaLabel,
  children,
  onClose,
  closeDisabled = false,
  closeLabel = "Close modal",
  contentClassName,
  showCloseButton = true,
  size = "md",
}: ModalProps) {
  const [mounted, setMounted] = useState(false);
  const canClose = Boolean(onClose) && !closeDisabled;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEscapeKey(isOpen && canClose, () => {
    onClose?.();
  });

  if (!mounted || !isOpen) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-[rgba(18,18,19,0.44)]">
      {onClose ? (
        <button
          type="button"
          aria-label={closeLabel}
          className="absolute inset-0 cursor-default"
          onClick={onClose}
          disabled={!canClose}
          tabIndex={-1}
        />
      ) : (
        <div className="absolute inset-0" />
      )}

      <div className="pointer-events-none relative flex min-h-full items-center justify-center px-4 py-8">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          className={cn(
            "pointer-events-auto relative z-10 w-full rounded-2xl border border-[rgba(28,28,29,0.16)] bg-white text-[#1c1c1d] shadow-lg",
            sizeClassNames[size],
            contentClassName
          )}
        >
          {showCloseButton && onClose ? (
            <ModalCloseButton onClick={onClose} disabled={!canClose} label={closeLabel} />
          ) : null}
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
