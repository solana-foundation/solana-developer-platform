"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const PANEL_HEADING_SELECTOR = "[data-modal-focus-heading]";

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
 * Three parts, and the split between the first two is load-bearing:
 *
 * 1. **Panel focus** runs on every `panelKey`, independently of the modal
 *    lifecycle. A wizard keeps the same dialog mounted while replacing its
 *    focused Continue/Submit button; without a second effect, focus falls to
 *    `body` and the next panel is never announced.
 * 2. **Trap** is mount-level and cycles Tab/Shift-Tab within the nearest
 *    `[role="dialog"]`
 *    ancestor. Scoped to that ancestor rather than to the ref so that popovers
 *    portaled INSIDE the dialog (Select, Tooltip) stay reachable. If focus has
 *    already escaped, the next Tab recovers it into the dialog.
 * 3. **Return focus** to the element that had it, or — when that element was
 *    unmounted by a re-render while the dialog was open — to a trigger marked
 *    with `data-modal-focus-fallback="<fallbackId>"`. The id must be the
 *    attribute's VALUE, not a bare attribute: with several cards on screen an
 *    unscoped query lands focus on whichever rendered first, which is a
 *    different row than the one the reader was working in.
 *
 * @param fallbackId Identifies the trigger to return focus to if it remounts.
 * @param panelKey Changes whenever the modal replaces its visible panel.
 */
export function useModalFocus<T extends HTMLElement = HTMLDivElement>(
  fallbackId: string,
  panelKey: string = fallbackId
) {
  const contentRef = useRef<T>(null);

  useEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = contentRef.current?.closest<HTMLElement>('[role="dialog"]');
      if (!dialog) return;
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

  useEffect(() => {
    // One frame lets Modal's portal mount and lets a state transition replace
    // its panel before querying. Inputs are the most useful landing target for
    // the two form panels; a marked heading is the semantic fallback for
    // loading, empty, and result panels; the first ordinary control is last.
    const focusFrame = window.requestAnimationFrame(() => {
      const content = contentRef.current;
      if (!content) return;
      // A keyed panel can expose the same value on its root. This guards a
      // queued frame from focusing a replacement that rendered after it was
      // scheduled; unkeyed single-panel consumers remain supported.
      const renderedPanelKey = content.dataset.modalFocusPanel;
      if (renderedPanelKey !== undefined && renderedPanelKey !== panelKey) return;
      const target =
        content.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled])') ??
        content.querySelector<HTMLElement>(PANEL_HEADING_SELECTOR) ??
        content.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      target?.focus();
    });

    return () => window.cancelAnimationFrame(focusFrame);
  }, [panelKey]);

  return contentRef;
}
