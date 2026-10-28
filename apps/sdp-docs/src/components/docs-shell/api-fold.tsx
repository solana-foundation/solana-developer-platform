"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/** The tab's code viewport Fumadocs renders (`fumadocs-ui/components/codeblock`). */
const CODE_VIEWPORT = ".fd-scroll-container";

/**
 * A long request sample (scripts/lib/api-reference-page.ts), held to its first lines until
 * opened. The button shows only while the open tab's code runs past the fold, and it sits over
 * the code, so measuring never moves the page.
 */
export function ApiFold({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const container = ref.current;
    if (container === null || open) return;
    const measure = () => {
      const viewports = [...container.querySelectorAll<HTMLElement>(CODE_VIEWPORT)];
      setOverflows(
        viewports.some(
          (viewport) =>
            viewport.offsetParent !== null && viewport.scrollHeight > viewport.clientHeight + 1
        )
      );
    };
    measure();
    // A tab switch changes the code, and so the fold's height or its overflow.
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    const mutations = new MutationObserver(measure);
    mutations.observe(container, { attributes: true, childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [open]);

  return (
    <div
      ref={ref}
      className="launch-api-fold"
      data-open={open ? "" : undefined}
      data-overflows={overflows && !open ? "" : undefined}
    >
      {children}
      {overflows && !open ? (
        <button type="button" className="launch-api-fold-toggle" onClick={() => setOpen(true)}>
          Show all lines
        </button>
      ) : null}
    </div>
  );
}
