"use client";

import { type FocusEvent, useEffect, useEffectEvent, useRef } from "react";
import { cn } from "@/lib/utils";
import { externalLinkProps } from "../homepage-links";
import styles from "./nav.module.css";
import type { NavGroup, NavGroupId } from "./nav-types";

const OPEN_DELAY_MS = 90;
const CLOSE_DELAY_MS = 180;
/** A click this soon after hover opened the panel confirms it rather than closing it. */
const CLICK_GRACE_MS = 400;

/** An Escape meant for a menu of its own (the language dropdown) is not ours. */
export function isOwnMenuKey(event: KeyboardEvent) {
  return event.target instanceof Element && event.target.closest('[role="menu"]') !== null;
}

/**
 * The bar's groups. Each trigger is a disclosure button: a click, Enter or Space opens and closes
 * its panel. A mouse also opens a panel by hovering its group and closes it by leaving. A panel
 * closes on Escape (focus returns to its trigger), a click elsewhere, or focus leaving its group.
 * Focus alone never opens a panel, so Tab walks the bar's triggers, not every panel's links.
 */
export function NavPanels({
  groups,
  label,
  openIndex,
  here,
  onOpenChange,
}: {
  groups: NavGroup[];
  label: string;
  openIndex: number | null;
  here: NavGroupId | null;
  onOpenChange: (index: number | null) => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const triggerRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const openedAt = useRef(0);

  const open = (index: number | null) => {
    if (index !== null && index !== openIndex) openedAt.current = performance.now();
    onOpenChange(index);
  };
  const openFromHover = useEffectEvent(open);

  // Hover is a mouse shortcut on the group (trigger and panel together); the trigger button is
  // the keyboard and click path. Native listeners, since the group itself is not interactive.
  useEffect(() => {
    const items = Array.from(
      navRef.current?.querySelectorAll<HTMLElement>("[data-nav-item]") ?? []
    );
    let openTimer = 0;
    let closeTimer = 0;
    const cleanups = items.map((item, index) => {
      const onEnter = () => {
        window.clearTimeout(closeTimer);
        window.clearTimeout(openTimer);
        openTimer = window.setTimeout(() => openFromHover(index), OPEN_DELAY_MS);
      };
      const onLeave = () => {
        window.clearTimeout(openTimer);
        closeTimer = window.setTimeout(() => openFromHover(null), CLOSE_DELAY_MS);
      };
      item.addEventListener("mouseenter", onEnter);
      item.addEventListener("mouseleave", onLeave);
      return () => {
        item.removeEventListener("mouseenter", onEnter);
        item.removeEventListener("mouseleave", onLeave);
      };
    });
    return () => {
      window.clearTimeout(openTimer);
      window.clearTimeout(closeTimer);
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  useEffect(() => {
    if (openIndex === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isOwnMenuKey(event)) return;
      const trigger = triggerRefs.current[openIndex];
      const hadFocus = trigger?.parentElement?.contains(document.activeElement) ?? false;
      onOpenChange(null);
      if (hadFocus) trigger?.focus();
    };
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !navRef.current?.contains(event.target)) {
        onOpenChange(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
    };
  }, [openIndex, onOpenChange]);

  /**
   * Focus moving to another element outside the open group (the next trigger, or off the bar)
   * closes its panel. Focus going nowhere — a click on the panel's own padding, or the window
   * losing focus — leaves it open; clicks outside are closed by the document listener above.
   */
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (openIndex === null) return;
    const next = event.relatedTarget;
    if (!(next instanceof Node)) return;
    const openItem = triggerRefs.current[openIndex]?.parentElement;
    if (!openItem?.contains(next)) onOpenChange(null);
  };

  return (
    <nav ref={navRef} className={styles.menu} aria-label={label} onBlur={onBlur}>
      {groups.map((group, index) => {
        const isOpen = openIndex === index;
        return (
          <div
            key={group.id}
            data-nav-item
            className={cn(
              styles.item,
              isOpen && styles.itemOpen,
              here === group.id && styles.itemHere
            )}
          >
            <button
              ref={(el) => {
                triggerRefs.current[index] = el;
              }}
              type="button"
              className={styles.trigger}
              aria-expanded={isOpen}
              aria-controls={group.id}
              onClick={() => {
                if (isOpen && performance.now() - openedAt.current < CLICK_GRACE_MS) return;
                open(isOpen ? null : index);
              }}
            >
              {group.label}
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" />
              </svg>
            </button>
            <section id={group.id} className={styles.panel} aria-label={group.label}>
              <div className={styles.features}>
                {group.features.map((feature) => (
                  <a
                    key={feature.label}
                    className={styles.feature}
                    href={feature.href}
                    {...externalLinkProps(feature.external)}
                    aria-label={feature.ariaLabel}
                    onClick={() => onOpenChange(null)}
                  >
                    <b>{feature.label}</b>
                    <span>{feature.body}</span>
                  </a>
                ))}
              </div>
              <div className={styles.links}>
                {group.links.map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    {...externalLinkProps(link.external)}
                    aria-label={link.ariaLabel}
                    onClick={() => onOpenChange(null)}
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </section>
          </div>
        );
      })}
    </nav>
  );
}
