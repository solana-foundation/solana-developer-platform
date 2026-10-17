"use client";

import { useReducedMotion } from "motion/react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Rise } from "../rise";
import styles from "./interfaces.module.css";
import { RequestCard } from "./request-card";
import { INTERFACE_SNIPPETS, type InterfaceMode } from "./snippets";

type InterfaceModeCopy = { title: string; body: string; status: string };

type InterfacesConsoleProps = {
  copy: Record<InterfaceMode, InterfaceModeCopy>;
  modesLabel: string;
  responseLabel: string;
  /** The reference links set under the modes. */
  links: ReactNode;
};

/** Wait half a second after the card lands before the first call rolls in. */
const START_DELAY_MS = 500;
const LAST = INTERFACE_SNIPPETS.length - 1;

type BarState = "idle" | "turning" | "held";

/** The chosen way's line: empty before the card lands, filling while the ways turn, else full. */
function barState(shown: boolean, turning: boolean): BarState {
  if (!shown) return "idle";
  return turning ? "turning" : "held";
}

const BAR_CLASS = { idle: undefined, turning: styles.barRun, held: styles.barFull } as const;

/** Arrow keys move along the tabs and wrap at either end; Home and End jump to the ends. */
const KEY_STEPS: Record<string, (index: number) => number> = {
  ArrowDown: (index) => (index === LAST ? 0 : index + 1),
  ArrowRight: (index) => (index === LAST ? 0 : index + 1),
  ArrowUp: (index) => (index === 0 ? LAST : index - 1),
  ArrowLeft: (index) => (index === 0 ? LAST : index - 1),
  Home: () => 0,
  End: () => LAST,
};

/**
 * The three ways in are the tabs of the call beside them. On a timer (the line under the chosen
 * way filling over 6.2s) the tabs take turns; a way under the mouse holds while it is there, and a
 * tap, a click or the keyboard holds the chosen way until the block leaves the screen. Keyboard
 * focus on the tabs also holds, and nothing turns off screen, in a hidden tab or under reduced
 * motion.
 */
export function InterfacesConsole({
  copy,
  modesLabel,
  responseLabel,
  links,
}: InterfacesConsoleProps) {
  const reducedMotion = useReducedMotion();
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const chosenRef = useRef(false);
  const [active, setActive] = useState(0);
  const [started, setStarted] = useState(false);
  const [held, setHeld] = useState(false);
  const [seen, setSeen] = useState(false);
  const [pageHidden, setPageHidden] = useState(false);
  // Bumped to restart the active line's fill from empty.
  const [cycle, setCycle] = useState(0);

  const release = useCallback(() => {
    chosenRef.current = false;
    setHeld(false);
    setCycle((value) => value + 1);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        setSeen(entry.isIntersecting);
        if (!entry.isIntersecting && chosenRef.current) release();
      },
      { threshold: 0.25 }
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [release]);

  useEffect(() => {
    const update = () => setPageHidden(document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const startTimer = useRef<number | null>(null);
  const handleArrive = useCallback(() => {
    if (startTimer.current !== null) return;
    startTimer.current = window.setTimeout(() => setStarted(true), START_DELAY_MS);
  }, []);
  useEffect(
    () => () => {
      if (startTimer.current !== null) window.clearTimeout(startTimer.current);
    },
    []
  );

  function choose(index: number) {
    chosenRef.current = true;
    setHeld(true);
    setStarted(true);
    setActive(index);
  }

  function handlePointerEnter(event: PointerEvent, index: number) {
    if (event.pointerType !== "mouse") return;
    setHeld(true);
    setStarted(true);
    setActive(index);
  }

  function handlePointerLeave(event: PointerEvent) {
    if (event.pointerType !== "mouse" || chosenRef.current) return;
    if (tablistRef.current?.contains(document.activeElement)) return;
    release();
  }

  function handleKeyDown(event: KeyboardEvent, index: number) {
    const next = KEY_STEPS[event.key]?.(index);
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
    tabRefs.current[next]?.focus();
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    if (!chosenRef.current) release();
  }

  const turning = started && !reducedMotion && !held;
  const snippet = INTERFACE_SNIPPETS[active];
  const tabId = (index: number) => `${baseId}-tab-${index}`;
  const panelId = `${baseId}-panel`;

  return (
    <div ref={rootRef} className={styles.ifc}>
      <Rise index={1} className={styles.ways}>
        <div
          ref={tablistRef}
          role="tablist"
          aria-label={modesLabel}
          aria-orientation="vertical"
          className={styles.tabs}
          onFocus={() => setHeld(true)}
          onBlur={handleBlur}
        >
          {INTERFACE_SNIPPETS.map((each, index) => {
            const selected = index === active;
            const bar = barState(started && selected, turning);
            return (
              <button
                key={each.mode}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={tabId(index)}
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                className={cn(styles.way, selected && styles.wayOn)}
                onClick={() => choose(index)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                onPointerEnter={(event) => handlePointerEnter(event, index)}
                onPointerLeave={handlePointerLeave}
              >
                <b className={styles.wayTitle}>{copy[each.mode].title}</b>
                <span className={styles.wayBody}>{copy[each.mode].body}</span>
                <span className={styles.wayBar} aria-hidden="true">
                  <i
                    key={cycle}
                    data-state={bar}
                    className={BAR_CLASS[bar]}
                    style={{ animationPlayState: seen && !pageHidden ? "running" : "paused" }}
                    onAnimationEnd={() => setActive(index === LAST ? 0 : index + 1)}
                  />
                </span>
              </button>
            );
          })}
        </div>
        <div className={styles.reflinks}>{links}</div>
      </Rise>
      <Rise
        index={2}
        className={styles.req}
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(active)}
      >
        <RequestCard
          snippet={snippet}
          status={copy[snippet.mode].status}
          responseLabel={responseLabel}
          rolling={started}
          onArrive={handleArrive}
        />
      </Rise>
    </div>
  );
}
