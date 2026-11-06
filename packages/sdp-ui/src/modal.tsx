"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";
import { useUiTranslations } from "./i18n";
import { ModalCloseButton } from "./modal-close-button";
import { playEntrance } from "./motion";
import { PortalContainerProvider } from "./portal-container";
import { useEscapeKey } from "./use-escape-key";

type ModalSize = "sm" | "md" | "lg" | "xl";

/**
 * Where the dialog sits. `center` is the default; `top` pins its top edge a fixed distance
 * down, so a flow whose steps differ in height grows and shrinks below a still header rather
 * than re-centring at every step.
 */
type ModalPlacement = "center" | "top";

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
  placement?: ModalPlacement;
}

const sizeClassNames: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-xl",
  xl: "max-w-2xl",
};

const placementClassNames = {
  center: "items-center",
  top: "items-start pt-[min(12dvh,6rem)]",
} as const satisfies Record<ModalPlacement, string>;

/**
 * A dialog that opens this soon after another closed is taking its place (a loading dialog
 * giving way to the real one), so it opens as it is: an entrance there would blink the backdrop.
 */
const HANDOFF_WINDOW_MS = 100;
let lastClosedAt = Number.NEGATIVE_INFINITY;

export function Modal({
  isOpen,
  ariaLabel,
  children,
  onClose,
  closeDisabled = false,
  closeLabel,
  contentClassName,
  showCloseButton = true,
  size = "md",
  placement = "center",
}: ModalProps) {
  const t = useUiTranslations();
  const resolvedCloseLabel = closeLabel ?? t("Shared.SharedComponents.closeModal");
  const [mounted, setMounted] = useState(false);
  const [dialogNode, setDialogNode] = useState<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const canClose = Boolean(onClose) && !closeDisabled;

  // The state re-renders the portal container; the ref reaches the entrance in the same commit.
  const attachPanel = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    setDialogNode(node);
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Before the first paint, so an opening dialog never shows a frame before its entrance.
  useLayoutEffect(() => {
    if (!mounted || !isOpen) {
      return;
    }
    const backdrop = backdropRef.current;
    const panel = panelRef.current;
    if (backdrop && panel && performance.now() - lastClosedAt >= HANDOFF_WINDOW_MS) {
      playEntrance(backdrop, [{ opacity: 0 }, { opacity: 1 }]);
      playEntrance(panel, [{ transform: "scale(0.97)" }, { transform: "none" }]);
    }
    return () => {
      lastClosedAt = performance.now();
    };
  }, [mounted, isOpen]);

  useEscapeKey(isOpen && canClose, () => {
    onClose?.();
  });

  if (!mounted || !isOpen) {
    return null;
  }

  return createPortal(
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-[rgba(18,18,19,0.44)]"
    >
      {onClose ? (
        <button
          type="button"
          aria-label={resolvedCloseLabel}
          className="absolute inset-0 cursor-default"
          onClick={onClose}
          disabled={!canClose}
          tabIndex={-1}
        />
      ) : (
        <div className="absolute inset-0" />
      )}

      <div
        className={cn(
          "pointer-events-none relative flex min-h-full justify-center px-4 py-8",
          placementClassNames[placement]
        )}
      >
        <div
          ref={attachPanel}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          className={cn(
            "pointer-events-auto relative z-10 w-full rounded-2xl border border-border-default bg-surface-raised text-primary shadow-lg",
            sizeClassNames[size],
            contentClassName
          )}
        >
          {showCloseButton && onClose ? (
            <ModalCloseButton onClick={onClose} disabled={!canClose} label={resolvedCloseLabel} />
          ) : null}
          <PortalContainerProvider container={dialogNode}>{children}</PortalContainerProvider>
        </div>
      </div>
    </div>,
    document.body
  );
}
