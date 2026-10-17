"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { easeOutCubic } from "@/lib/easing";
import { formatNumber } from "@/lib/number-format";
import { watchActive } from "@/lib/use-scene-active";
import { cn } from "@/lib/utils";
import styles from "./issuance-section.module.css";
import { restartClass } from "./restart-animation";
import { useRiseArrived } from "./rise";

type IssuanceStatus = "live" | "minted" | "paused" | "resumed" | "burned";
type TransferControl = "blocklist" | "paused";
type IssuanceStep = {
  status: Exclude<IssuanceStatus, "live">;
  row: "supply" | "transferControls";
  supplyDelta?: number;
  transferControl?: TransferControl;
};

const INITIAL_SUPPLY = 100_000_000;

/** The lifecycle the sheet runs through, one operation every STEP_MS. */
const ISSUANCE_STEPS: readonly IssuanceStep[] = [
  { status: "minted", row: "supply", supplyDelta: 250_000 },
  { status: "paused", row: "transferControls", transferControl: "paused" },
  { status: "resumed", row: "transferControls", transferControl: "blocklist" },
  { status: "burned", row: "supply", supplyDelta: -250_000 },
];

const STEP_MS = 2800;
const SWAP_MS = 220;
const COUNT_MS = 900;
/** The sheet starts once its block has landed, like every motion inside a block. */
const ARRIVE_DELAY_MS = 900;

const STATUS_KEYS = {
  live: "Homepage.issuance.sheet.status.live",
  minted: "Homepage.issuance.sheet.status.minted",
  paused: "Homepage.issuance.sheet.status.paused",
  resumed: "Homepage.issuance.sheet.status.resumed",
  burned: "Homepage.issuance.sheet.status.burned",
} as const satisfies Record<IssuanceStatus, MessageKey>;

const TRANSFER_CONTROL_KEYS = {
  blocklist: "Homepage.issuance.sheet.blocklist",
  paused: "Homepage.issuance.sheet.paused",
} as const satisfies Record<TransferControl, MessageKey>;

function StatusIcon({ status }: { status: IssuanceStatus }) {
  return (
    <svg className={styles.statusSvg} viewBox="0 0 24 24" aria-hidden="true">
      {status === "live" && <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />}
      {status === "minted" && <path d="M12 7v10M7 12h10" />}
      {status === "paused" && <path d="M9.5 7.5v9M14.5 7.5v9" />}
      {status === "resumed" && <path d="M9.5 7.6v8.8l7-4.4z" fill="currentColor" stroke="none" />}
      {status === "burned" && (
        <path d="M12 20c3.3 0 5.5-2.3 5.5-5.4 0-3.6-3-5.2-3.8-8.6-2 1.4-3 3.3-3 5.3-1-.6-1.6-1.6-1.8-2.6-1.4 1.4-2.4 3.4-2.4 5.9C6.5 17.7 8.7 20 12 20z" />
      )}
    </svg>
  );
}

/**
 * An example asset sheet that keeps its lifecycle: in turn the asset is minted (the supply counts
 * up), paused and resumed (the transfer controls say so) and burned (the supply counts back). The
 * status says each operation and beats; the row it touched lights for a moment. The loop is not
 * announced to screen readers, and under reduced motion the sheet stays in its first state.
 */
export function IssuanceSheet() {
  const t = useTranslations();
  const locale = useLocale();
  const reducedMotion = useReducedMotion();
  const arrived = useRiseArrived();

  const sheetRef = useRef<HTMLDListElement>(null);
  const statusRef = useRef<HTMLElement>(null);
  const supplyRowRef = useRef<HTMLDivElement>(null);
  const transferRowRef = useRef<HTMLDivElement>(null);

  const [status, setStatus] = useState<IssuanceStatus>("live");
  const [statusOut, setStatusOut] = useState(false);
  const [transferControl, setTransferControl] = useState<TransferControl>("blocklist");
  const [transferOut, setTransferOut] = useState(false);
  const [supply, setSupply] = useState(INITIAL_SUPPLY);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || reducedMotion || arrived === false) return;

    const timers = new Set<number>();
    const later = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };

    let ready = false;
    let seen = false;
    let frame = 0;
    let last = 0;
    let elapsed = 0;
    let stepIndex = -1;
    let currentSupply = INITIAL_SUPPLY;
    let count: { from: number; to: number; elapsed: number } | null = null;

    const step = () => {
      stepIndex = (stepIndex + 1) % ISSUANCE_STEPS.length;
      const next = ISSUANCE_STEPS[stepIndex];
      if (!next) return;

      setStatusOut(true);
      later(() => {
        setStatus(next.status);
        setStatusOut(false);
      }, SWAP_MS);
      restartClass(statusRef.current, styles.beat);
      restartClass(
        next.row === "supply" ? supplyRowRef.current : transferRowRef.current,
        styles.hot
      );

      const control = next.transferControl;
      if (control) {
        setTransferOut(true);
        later(() => {
          setTransferControl(control);
          setTransferOut(false);
        }, SWAP_MS);
      }
      if (next.supplyDelta) {
        count = { from: currentSupply, to: currentSupply + next.supplyDelta, elapsed: 0 };
        currentSupply += next.supplyDelta;
      }
    };

    const tick = (now: number) => {
      const dt = Math.min(1000, now - last);
      last = now;
      elapsed += dt;
      if (elapsed >= STEP_MS) {
        elapsed = 0;
        step();
      }
      if (count) {
        count.elapsed += dt;
        const progress = Math.min(1, count.elapsed / COUNT_MS);
        setSupply(count.from + (count.to - count.from) * easeOutCubic(progress));
        if (progress >= 1) count = null;
      }
      frame = window.requestAnimationFrame(tick);
    };

    // The loop runs only while the sheet is on screen and the tab is visible.
    const run = () => {
      if (frame || !ready || !seen || document.hidden) return;
      last = performance.now();
      frame = window.requestAnimationFrame(tick);
    };
    const stop = () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
    };

    const stopWatching = watchActive(sheet, { threshold: 0.3 }, (active) => {
      seen = active;
      if (active) run();
      else stop();
    });
    later(() => {
      ready = true;
      run();
    }, ARRIVE_DELAY_MS);

    return () => {
      stop();
      stopWatching();
      for (const id of timers) window.clearTimeout(id);
    };
  }, [reducedMotion, arrived]);

  return (
    <dl ref={sheetRef} className={styles.sheet}>
      <div className={cn(styles.row, styles.top)}>
        <dt>
          {t("Homepage.issuance.sheet.asset")}{" "}
          <em className={styles.note}>{t("Homepage.issuance.sheet.assetNote")}</em>
        </dt>
        <dd>
          <b ref={statusRef} className={styles.status}>
            <i className={cn(styles.statusIcon, statusOut && styles.iconOut)} aria-hidden="true">
              <StatusIcon status={status} />
            </i>
            <span className={cn(styles.swap, statusOut && styles.out)}>
              {t(STATUS_KEYS[status])}
            </span>
          </b>
        </dd>
      </div>
      <div className={styles.row}>
        <dt>{t("Homepage.issuance.sheet.standardLabel")}</dt>
        <dd className={styles.value}>{t("Homepage.issuance.sheet.standardValue")}</dd>
      </div>
      <div ref={supplyRowRef} className={cn(styles.row, styles.lit)}>
        <dt>{t("Homepage.issuance.sheet.supplyLabel")}</dt>
        <dd className={cn(styles.value, styles.supply)}>{formatNumber(locale, supply)}</dd>
      </div>
      <div ref={transferRowRef} className={cn(styles.row, styles.lit)}>
        <dt>{t("Homepage.issuance.sheet.transferControlsLabel")}</dt>
        <dd className={styles.value}>
          <span className={cn(styles.swap, transferOut && styles.out)}>
            {t(TRANSFER_CONTROL_KEYS[transferControl])}
          </span>
        </dd>
      </div>
      <div className={styles.row}>
        <dt>{t("Homepage.issuance.sheet.authorityLabel")}</dt>
        <dd className={styles.value}>{t("Homepage.issuance.sheet.authorityValue")}</dd>
      </div>
      <div className={styles.row}>
        <dt>{t("Homepage.issuance.sheet.privacyLabel")}</dt>
        <dd className={styles.value}>{t("Homepage.issuance.sheet.privacyValue")}</dd>
      </div>
    </dl>
  );
}
