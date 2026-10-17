"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { LanguagePicker } from "@/components/language-picker";
import { cn } from "@/lib/utils";
import shared from "../homepage.module.css";
import { externalLinkProps } from "../homepage-links";
import { MobileMenu } from "./mobile-menu";
import styles from "./nav.module.css";
import { NavPanels } from "./nav-panels";
import type { NavShellProps } from "./nav-types";
import { useNavScroll, useScrollSpy } from "./use-nav-scroll";

const MOBILE_MENU_ID = "homepage-mobile-menu";

/**
 * The sticky bar with its panels, the scrim under an open panel, and the phone menu. The root
 * uses `display: contents` so the bar stays sticky against the page and the fixed scrim and menu
 * are not caught by the bar's backdrop filter; it carries the ground the bar is over.
 */
export function NavShell({
  copy,
  groups,
  mobileLinks,
  signInHref,
  signup,
  signedIn = false,
}: NavShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const [openPanel, setOpenPanel] = useState<number | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { ground, scrolled } = useNavScroll(rootRef);
  const here = useScrollSpy();

  const closeMobile = useCallback((returnFocus: boolean) => {
    setMobileOpen(false);
    if (returnFocus) burgerRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div ref={rootRef} className={styles.root} data-homepage-nav data-ground={ground}>
      <a className={styles.skip} href="#main">
        {copy.skip}
      </a>
      <header id="nav" className={cn(styles.bar, scrolled && styles.scrolled)}>
        <div className={styles.inner}>
          <Link className={styles.brand} href="/" aria-label={copy.home}>
            <Image
              className={styles.onLight}
              src="/homepage/v6/logo-sdp-lockup-on-light.svg"
              alt=""
              width={78}
              height={30}
              preload
            />
            <Image
              className={styles.onDark}
              src="/homepage/v6/logo-sdp-lockup-on-dark.svg"
              alt=""
              width={78}
              height={30}
            />
          </Link>
          <NavPanels
            groups={groups}
            label={copy.primary}
            openIndex={openPanel}
            here={here}
            onOpenChange={setOpenPanel}
          />
          <div className={styles.right}>
            <span className={styles.lang}>
              <LanguagePicker variant="landing" />
            </span>
            {signedIn ? null : (
              <a className={cn(shared.btn, shared.btnGhost, styles.ghost)} href={signInHref}>
                {copy.signIn}
              </a>
            )}
            <a
              className={cn(shared.btn, shared.btnFill, styles.fill)}
              href={signup.href}
              {...externalLinkProps(signup.external)}
            >
              {signup.label}
            </a>
          </div>
          <button
            ref={burgerRef}
            type="button"
            className={styles.burger}
            aria-label={mobileOpen ? copy.closeMenu : copy.openMenu}
            aria-expanded={mobileOpen}
            aria-controls={MOBILE_MENU_ID}
            onClick={() => setMobileOpen((on) => !on)}
          >
            <span />
            <span />
          </button>
        </div>
      </header>
      {/* The page under an open panel blurs; a click on it is a click outside, which closes it. */}
      <div
        className={cn(styles.scrim, (openPanel !== null || mobileOpen) && styles.scrimOn)}
        aria-hidden="true"
      />
      <MobileMenu
        id={MOBILE_MENU_ID}
        open={mobileOpen}
        onClose={closeMobile}
        navRoot={rootRef}
        label={copy.menu}
        links={mobileLinks}
        signInLabel={copy.signIn}
        signInHref={signInHref}
        signup={signup}
        signedIn={signedIn}
      />
    </div>
  );
}
