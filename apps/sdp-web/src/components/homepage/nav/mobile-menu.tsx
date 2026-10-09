"use client";

import { type RefObject, useEffect, useRef } from "react";
import { LanguagePicker } from "@/components/language-picker";
import { cn } from "@/lib/utils";
import shared from "../homepage.module.css";
import { externalLinkProps, type SignupLink } from "../homepage-links";
import styles from "./nav.module.css";
import { isOwnMenuKey } from "./nav-panels";
import type { NavLink } from "./nav-types";

/**
 * Where the bar's groups come back; past it the menu is closed (the page grew past it). The other
 * side of nav.module.css's `@media (max-width: 1180px)`: keep the two in step.
 */
const WIDE_QUERY = "(min-width: 1181px)";

/**
 * The phone menu: the page while it is open. It takes focus, holds the page still (scroll lock on
 * the root element) and makes the rest of the homepage inert; Escape, a link, or the page growing
 * past the burger close it, and focus goes back to the burger.
 */
export function MobileMenu({
  id,
  open,
  onClose,
  navRoot,
  label,
  links,
  signInLabel,
  signInHref,
  signup,
  signedIn = false,
}: {
  id: string;
  open: boolean;
  onClose: (returnFocus: boolean) => void;
  navRoot: RefObject<HTMLElement | null>;
  label: string;
  links: NavLink[];
  signInLabel: string;
  signInHref: string;
  signup: SignupLink;
  signedIn?: boolean;
}) {
  const menuRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const previousOverflow = html.style.overflow;
    html.style.overflow = "hidden";

    // Everything on the homepage but the nav (the main content, the footer) leaves the tab order.
    const siblings = Array.from(navRoot.current?.parentElement?.children ?? []).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== navRoot.current && !el.inert
    );
    for (const el of siblings) el.inert = true;

    menuRef.current?.querySelector<HTMLElement>("a[href]")?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isOwnMenuKey(event)) onClose(true);
    };
    document.addEventListener("keydown", onKeyDown);

    const wide = window.matchMedia?.(WIDE_QUERY);
    const onWide = (event: MediaQueryListEvent) => {
      if (event.matches) onClose(false);
    };
    wide?.addEventListener("change", onWide);

    return () => {
      html.style.overflow = previousOverflow;
      for (const el of siblings) el.inert = false;
      document.removeEventListener("keydown", onKeyDown);
      wide?.removeEventListener("change", onWide);
    };
  }, [open, onClose, navRoot]);

  return (
    <nav
      ref={menuRef}
      id={id}
      className={styles.mobile}
      data-open={open}
      aria-label={label}
      hidden={!open}
    >
      {links.map((link) => (
        <a
          key={link.label}
          className={styles.mobileLink}
          href={link.href}
          {...externalLinkProps(link.external)}
          aria-label={link.ariaLabel}
          onClick={() => onClose(true)}
        >
          {link.label}
        </a>
      ))}
      <div className={styles.mobileLang}>
        <LanguagePicker variant="landing" />
      </div>
      <div className={styles.mobileCta}>
        {signedIn ? null : (
          <a
            className={cn(shared.btn, shared.btnLine, shared.btnLg)}
            href={signInHref}
            onClick={() => onClose(true)}
          >
            {signInLabel}
          </a>
        )}
        <a
          className={cn(shared.btn, shared.btnFill, shared.btnLg)}
          href={signup.href}
          {...externalLinkProps(signup.external)}
          onClick={() => onClose(true)}
        >
          {signup.label}
        </a>
      </div>
    </nav>
  );
}
