"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalFocusOptions {
  /** Re-run initial focus when the modal changes panels or identity. */
  focusKey: string;
  initialFocusSelector: string;
  /**
   * Data attribute identifying the element to focus when the trigger is gone by
   * the time the modal closes — a row action that re-rendered, say. A plain
   * parameter: nothing here is domain-specific, so the caller names its own.
   */
  fallbackAttribute: string;
  fallbackValue: string;
  restoreTiming?: "immediate" | "animation-frame";
  contentDataKey?: string;
}

function findFocusFallback(attribute: string, value: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    if (element.getAttribute(attribute) === value) return element;
  }
  return null;
}

/**
 * Focus containment and trigger restoration for a portaled modal.
 *
 * Generic a11y machinery, deliberately NOT parked in a feature directory: it
 * started in the Earn module and every modal-heavy surface would otherwise
 * reinvent the tab cycle and the restore-on-close rules. Escape stays owned by
 * the common `Modal`, so close semantics remain aligned across the dashboard.
 */
export function useModalFocus({
  focusKey,
  initialFocusSelector,
  fallbackAttribute,
  fallbackValue,
  restoreTiming = "immediate",
  contentDataKey,
}: ModalFocusOptions) {
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
