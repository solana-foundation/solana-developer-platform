"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The focus lifecycle a portaled dialog needs and the shared `Modal` does not
 * provide.
 *
 * `Modal` gives a portal, `role="dialog"`, `aria-modal`, Escape-to-close and a
 * backdrop — but nothing about focus: no initial focus, no trap, no
 * restoration. On its own that means keyboard focus stays on, or tabs into,
 * page content the dialog visually covers, and never returns to whatever opened
 * it. Lifted here from `EarnWithdrawModal`, where it was a private hook, so the
 * money-IN and money-OUT halves of the same position behave identically rather
 * than one of them silently going without.
 *
 * Three parts, and the fallback is the subtle one:
 *
 * 1. **Initial focus** on the first enabled input inside the dialog, on the
 *    next frame — the portal's children are not in the document yet when the
 *    effect runs.
 * 2. **Trap** on Tab/Shift-Tab, cycling within the nearest `[role="dialog"]`
 *    ancestor. Scoped to that ancestor rather than to the ref so that popovers
 *    portaled INSIDE the dialog (Select, Tooltip) stay reachable.
 * 3. **Return focus** to the element that had it, or — when that element was
 *    unmounted by a re-render while the dialog was open — to a trigger marked
 *    with `data-modal-focus-fallback="<fallbackId>"`. The id must be the
 *    attribute's VALUE, not a bare attribute: with several cards on screen an
 *    unscoped query lands focus on whichever rendered first, which is a
 *    different row than the one the reader was working in.
 *
 * @param fallbackId Identifies the trigger to return focus to if it remounts.
 */
export function useModalFocus<T extends HTMLElement = HTMLDivElement>(fallbackId: string) {
  const contentRef = useRef<T>(null);

  useEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled])')
        ?.focus();
    });

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
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", trapFocus);
      window.requestAnimationFrame(() => {
        const focusTarget = returnFocus?.isConnected
          ? returnFocus
          : document.querySelector<HTMLElement>(
              `[data-modal-focus-fallback="${CSS.escape(fallbackId)}"]`
            );
        focusTarget?.focus();
      });
    };
  }, [fallbackId]);

  return contentRef;
}
