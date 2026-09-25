"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { useEscapeKey } from "@/lib/use-escape-key";
import styles from "./home-nav-menu.module.css";
import type { NavGroup } from "./homepage-links";
import { NavAnchor } from "./nav-anchor";

const OPEN_DELAY_MS = 90;
const CLOSE_DELAY_MS = 180;

type HomeNavMenuProps = {
  groups: NavGroup[];
  /** Tells the bar a panel is open, so it can blur the page under it. */
  onOpenChange: (open: boolean) => void;
};

/**
 * The bar's three groups, each a disclosure button with a panel under it.
 * A panel opens on hover or on the button itself, and closes on Escape
 * (focus returns to its button), a click outside, focus leaving the group,
 * or choosing a link. Focusing a button does not open it, so tabbing along
 * the bar never walks through every panel.
 */
export function HomeNavMenu({ groups, onOpenChange }: HomeNavMenuProps) {
  const t = useTranslations();
  const [openId, setOpenId] = useState<NavGroup["id"] | null>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const idPrefix = useId();
  const triggerId = useCallback((id: NavGroup["id"]) => `${idPrefix}${id}-trigger`, [idPrefix]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const schedule = useCallback((next: NavGroup["id"] | null, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpenId(next), delay);
  }, []);

  const close = useCallback(() => {
    clearTimeout(timer.current);
    setOpenId(null);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    onOpenChange(openId !== null);
  }, [openId, onOpenChange]);

  // Escape closes the open panel and hands focus back to its button.
  useEscapeKey(openId !== null, () => {
    if (openId) document.getElementById(triggerId(openId))?.focus();
    close();
  });

  useEffect(() => {
    if (!openId) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openId, close]);

  return (
    <ul ref={menuRef} className={styles.menu}>
      {groups.map((group) => {
        const open = openId === group.id;
        const panelId = `${idPrefix}${group.id}`;
        return (
          <li
            key={group.id}
            className={styles.item}
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") schedule(group.id, OPEN_DELAY_MS);
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") schedule(null, CLOSE_DELAY_MS);
            }}
            onBlur={(event) => {
              if (open && !event.currentTarget.contains(event.relatedTarget)) close();
            }}
          >
            <button
              type="button"
              id={triggerId(group.id)}
              className={styles.trigger}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => {
                clearTimeout(timer.current);
                setOpenId(open ? null : group.id);
              }}
            >
              {t(group.label)}
              <svg className={styles.chevron} viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" />
              </svg>
            </button>
            <div id={panelId} className={styles.panel} data-open={open}>
              <ul className={styles.features}>
                {group.features.map((feature) => (
                  <li key={feature.label}>
                    <NavAnchor link={feature} className={styles.feature} onNavigate={close}>
                      <b>{t(feature.label)}</b>
                      <span>{t(feature.description)}</span>
                    </NavAnchor>
                  </li>
                ))}
              </ul>
              <div className={styles.columns}>
                {group.columns.map((column) => (
                  <ul key={column.map((link) => link.label).join()} className={styles.column}>
                    {column.map((link) => (
                      <li key={link.label}>
                        <NavAnchor link={link} onNavigate={close}>
                          {t(link.label)}
                        </NavAnchor>
                      </li>
                    ))}
                  </ul>
                ))}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
