"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type EarnModalFocusFallbackAttribute =
  | "data-earn-vault-deposit-focus-fallback"
  | "data-earn-withdraw-focus-fallback";

interface EarnModalFocusOptions {
  /** Re-run initial focus when the modal changes panels or identity. */
  focusKey: string;
  initialFocusSelector: string;
  fallbackAttribute: EarnModalFocusFallbackAttribute;
  fallbackValue: string;
  restoreTiming?: "immediate" | "animation-frame";
  contentDataKey?: string;
}

function findFocusFallback(
  attribute: EarnModalFocusFallbackAttribute,
  value: string
): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    if (element.getAttribute(attribute) === value) return element;
  }
  return null;
}

/**
 * Shared focus containment and trigger restoration for portaled Earn modals.
 * Escape remains owned by the common `Modal`, so its close semantics stay
 * aligned with every other dashboard modal.
 */
export function useEarnModalFocus({
  focusKey,
  initialFocusSelector,
  fallbackAttribute,
  fallbackValue,
  restoreTiming = "immediate",
  contentDataKey,
}: EarnModalFocusOptions) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = contentRef.current?.closest<HTMLElement>('[role="dialog"]');
      if (!dialog?.contains(document.activeElement)) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => element.getAttribute("aria-hidden") !== "true"
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (!focusable.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      const restoreFocus = () => {
        const focusTarget = returnFocus?.isConnected
          ? returnFocus
          : findFocusFallback(fallbackAttribute, fallbackValue);
        focusTarget?.focus();
      };
      if (restoreTiming === "animation-frame") {
        window.requestAnimationFrame(restoreFocus);
      } else {
        restoreFocus();
      }
    };
  }, [fallbackAttribute, fallbackValue, restoreTiming]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const content = contentRef.current;
      if (content && contentDataKey) {
        content.dataset[contentDataKey] = focusKey;
      }
      content?.querySelector<HTMLElement>(initialFocusSelector)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contentDataKey, focusKey, initialFocusSelector]);

  return contentRef;
}
