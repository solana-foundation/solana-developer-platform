"use client";

import { ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import "@/styles/external-dialog.css";

/**
 * External MDX link that asks for confirmation before leaving the docs.
 *
 * @param props - Standard anchor props; `href` must be an absolute http(s) URL.
 * @returns The anchor plus, while open, a portal-mounted native dialog.
 */
export function ExternalDocsLink({
  href,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"a"> & { href: string }) {
  const [open, setOpen] = useState(false);
  const host = new URL(href).host;

  return (
    <>
      <a
        href={href}
        className={cn("launch-mdx-link launch-mdx-link-external", className)}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
        {...props}
      >
        {children}
        <ArrowUpRightIcon size={13} aria-hidden="true" />
      </a>
      {open &&
        createPortal(
          <dialog
            ref={(element) => {
              if (element && !element.open) {
                element.showModal();
              }
            }}
            className="launch-external-dialog"
            closedby="any"
            aria-label={`Leaving the SDP docs for ${host}`}
            onClose={() => setOpen(false)}
          >
            <p className="launch-external-dialog-text">
              You are leaving the SDP docs for <strong>{host}</strong>.
            </p>
            <div className="launch-external-dialog-actions">
              <button
                type="button"
                className="launch-docs-sidebar-action"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="launch-docs-sidebar-action"
                onClick={() => setOpen(false)}
              >
                Continue
                <ArrowUpRightIcon size={13} aria-hidden="true" />
              </a>
            </div>
          </dialog>,
          document.body
        )}
    </>
  );
}
