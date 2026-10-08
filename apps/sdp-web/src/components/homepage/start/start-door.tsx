"use client";

import { useReducedMotion } from "motion/react";
import Link from "next/link";
import type { PointerEvent } from "react";
import { externalLinkProps, type SignupLink } from "../homepage-links";
import styles from "./start.module.css";

/** How far the knob leans toward the pointer, in px, and the distance at which it leans fully. */
const LEAN = 10;
const LEAN_REACH = 360;

/**
 * The close's one action, across the whole width: a soft violet light follows the pointer over it,
 * and the arrow's knob leans toward the pointer by a few pixels (mouse only, not under reduced
 * motion).
 */
export function StartDoor({ signup, note }: { signup: SignupLink; note?: string }) {
  const reducedMotion = useReducedMotion();

  const onPointerMove = (event: PointerEvent<HTMLAnchorElement>) => {
    const door = event.currentTarget;
    const box = door.getBoundingClientRect();
    door.style.setProperty(
      "--mx",
      `${(((event.clientX - box.left) / box.width) * 100).toFixed(1)}%`
    );
    door.style.setProperty(
      "--my",
      `${(((event.clientY - box.top) / box.height) * 100).toFixed(1)}%`
    );
    const knob = door.querySelector<HTMLElement>("[data-knob]");
    if (!knob || reducedMotion || event.pointerType !== "mouse") return;
    const k = knob.getBoundingClientRect();
    const dx = event.clientX - (k.left + k.width / 2);
    const dy = event.clientY - (k.top + k.height / 2);
    const distance = Math.hypot(dx, dy) || 1;
    const lean = Math.min(1, distance / LEAN_REACH) * LEAN;
    knob.style.setProperty("--kx", `${((dx / distance) * lean).toFixed(1)}px`);
    knob.style.setProperty("--ky", `${((dy / distance) * lean).toFixed(1)}px`);
  };

  const onPointerLeave = (event: PointerEvent<HTMLAnchorElement>) => {
    const knob = event.currentTarget.querySelector<HTMLElement>("[data-knob]");
    knob?.style.removeProperty("--kx");
    knob?.style.removeProperty("--ky");
  };

  return (
    <Link
      href={signup.href}
      className={styles.door}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      {...externalLinkProps(signup.external)}
    >
      <span className={styles.doorText}>
        <b className={styles.doorTitle}>{signup.label}</b>
        {note ? <small className={styles.doorNote}>{note}</small> : null}
      </span>
      <span className={styles.knob} data-knob>
        <svg className={styles.arrow} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M3 8h10M9 4l4 4-4 4" />
        </svg>
      </span>
    </Link>
  );
}
