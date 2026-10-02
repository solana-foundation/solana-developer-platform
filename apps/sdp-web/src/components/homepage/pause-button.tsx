"use client";

import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import styles from "./pause-button.module.css";

type PauseButtonProps = {
  paused: boolean;
  onToggle: () => void;
  labels: { pause: MessageKey; play: MessageKey };
  className?: string;
};

/**
 * Stops and restarts content that moves on its own (WCAG 2.2.2). The label
 * says what pressing it will do, as media controls do.
 */
export function PauseButton({ paused, onToggle, labels, className }: PauseButtonProps) {
  const t = useTranslations();
  return (
    <button
      type="button"
      className={cn(styles.button, className)}
      aria-label={t(paused ? labels.play : labels.pause)}
      onClick={onToggle}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {paused ? <path d="M5 3.5v9l7-4.5z" /> : <path d="M5 3.5v9M11 3.5v9" />}
      </svg>
    </button>
  );
}
