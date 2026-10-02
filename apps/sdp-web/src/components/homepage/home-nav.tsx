"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LanguagePicker } from "@/components/language-picker";
import { useTranslations } from "@/i18n/provider";
import { useEscapeKey } from "@/lib/use-escape-key";
import { cn } from "@/lib/utils";
import { ExternalIcon } from "./external-icon";
import styles from "./home-nav.module.css";
import { HomeNavMenu } from "./home-nav-menu";
import { useHomepageGround } from "./homepage-ground";
import type { NavGroup, NavLink } from "./homepage-links";
import { NavAnchor } from "./nav-anchor";
import { onScrollFrame } from "./scroll-frame";

type HomeNavProps = {
  groups: NavGroup[];
  /** The primary action: the dashboard, account creation or the waitlist (homepagePrimaryAction). */
  primaryAction: NavLink;
  /** A signed-in visitor has no use for "Sign in"; the primary action takes them in. */
  signedIn: boolean;
};

const SIGN_IN: NavLink = { href: "/sign-in", label: "Homepage.nav.signIn" };

/**
 * The mobile menu: every destination in the groups once (the first label wins),
 * except desktop-only links, then sign-in (when signed out) and the primary action,
 * held back so they come last.
 */
function mobileLinks(groups: NavGroup[], primaryAction: NavLink, signedIn: boolean): NavLink[] {
  const seen = new Set([SIGN_IN.href, primaryAction.href]);
  const links = groups
    .flatMap((group) => [...group.features, ...group.columns.flat()])
    .filter((link) => {
      if (link.desktopOnly || seen.has(link.href)) return false;
      seen.add(link.href);
      return true;
    });
  return signedIn ? [...links, primaryAction] : [...links, SIGN_IN, primaryAction];
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls a keyboard can reach inside `roots`, in DOM order, skipping anything not laid out. */
function focusableWithin(roots: (HTMLElement | null)[]): HTMLElement[] {
  const all = roots.flatMap((root) =>
    root ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)) : []
  );
  const laidOut = all.filter((element) => element.getClientRects().length > 0);
  // Without layout (jsdom) nothing has a rect; fall back to DOM order.
  return laidOut.length > 0 ? laidOut : all;
}

export function HomeNav({ groups, primaryAction, signedIn }: HomeNavProps) {
  const t = useTranslations();
  const [scrolled, setScrolled] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const progressRef = useRef<HTMLSpanElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuId = useId();

  // The bar takes the page ground's colours with it (HomepageRoot decides the ground).
  const ground = useHomepageGround();

  // A hairline once the page has moved, and the reading progress along the top edge.
  useEffect(
    () =>
      onScrollFrame(() => {
        const scrollable = document.documentElement.scrollHeight - window.innerHeight;
        const progress = scrollable > 0 ? Math.min(1, window.scrollY / scrollable) : 0;
        setScrolled(window.scrollY > 8);
        if (progressRef.current) progressRef.current.style.transform = `scaleX(${progress})`;
      }),
    []
  );

  const closeMobile = useCallback((returnFocus: boolean) => {
    setMobileOpen(false);
    if (returnFocus) burgerRef.current?.focus();
  }, []);

  // Opening the mobile menu moves focus into it; Escape closes it and returns focus to the burger.
  useEffect(() => {
    if (mobileOpen) mobileMenuRef.current?.querySelector("a")?.focus();
  }, [mobileOpen]);
  useEscapeKey(mobileOpen, () => closeMobile(true));

  // While it is open, Tab stays within the bar and the menu: the page under the scrim is
  // not reachable, so Tab from the last link wraps to the bar and Shift+Tab from the bar's
  // first control wraps to the last link.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const focusable = focusableWithin([headerRef.current, mobileMenuRef.current]);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  return (
    <>
      <header ref={headerRef} className={styles.nav} data-scrolled={scrolled} data-ground={ground}>
        <span ref={progressRef} className={styles.progress} aria-hidden="true" />
        <div className={styles.inner}>
          <Link href="/" className={styles.brand} aria-label={t("Homepage.nav.home")}>
            <Image
              data-testid="homepage-sdp-mark"
              src="/homepage/logos/sdp-mark.svg"
              alt=""
              width={19}
              height={17}
              className={cn(styles.brandMark, "dark:invert")}
            />
            <b className={styles.brandWord} aria-hidden="true">
              {t("Homepage.nav.wordmark")}
            </b>
          </Link>
          <button
            ref={burgerRef}
            type="button"
            className={styles.burger}
            aria-expanded={mobileOpen}
            aria-controls={mobileMenuId}
            aria-label={t(mobileOpen ? "Homepage.nav.closeMenu" : "Homepage.nav.openMenu")}
            onClick={() => setMobileOpen((open) => !open)}
          >
            <span />
            <span />
          </button>
          <div className={styles.groups}>
            <nav aria-label={t("Homepage.nav.label")}>
              <HomeNavMenu groups={groups} onOpenChange={setPanelOpen} />
            </nav>
          </div>
          <div className={styles.actions}>
            <LanguagePicker variant="landing" />
            {signedIn ? null : (
              <Link href={SIGN_IN.href} className={cn(styles.ghost, styles.desktopOnly)}>
                {t(SIGN_IN.label)}
                <ExternalIcon />
              </Link>
            )}
            <NavAnchor link={primaryAction} className={cn(styles.fill, styles.desktopOnly)}>
              {t(primaryAction.label)}
              <ExternalIcon />
            </NavAnchor>
          </div>
        </div>
      </header>
      <div className={styles.scrim} data-open={panelOpen} aria-hidden="true" />
      <div ref={mobileMenuRef} id={mobileMenuId} className={styles.mobileMenu} hidden={!mobileOpen}>
        <nav aria-label={t("Homepage.nav.label")}>
          {mobileLinks(groups, primaryAction, signedIn).map((link) => (
            <NavAnchor key={link.href} link={link} onNavigate={() => closeMobile(false)}>
              {t(link.label)}
            </NavAnchor>
          ))}
        </nav>
      </div>
    </>
  );
}
