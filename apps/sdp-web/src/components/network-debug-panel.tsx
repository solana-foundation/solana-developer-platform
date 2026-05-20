"use client";

import { BanIcon, CheckIcon, CopyIcon, EraserIcon, PauseIcon, PlayIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { type NetworkDebugEntry, useNetworkDebug } from "@/contexts/network-debug-context";
import {
  formatNetworkDebugMetaSummary,
  formatNetworkDebugPayloadValue,
  getNetworkDebugStatusClassName,
} from "@/lib/network-debug";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

const PANEL_TRANSITION = { type: "spring", duration: 0.38, bounce: 0 } as const;
const CONTENT_FADE_PROPS = {
  initial: { opacity: 0, filter: "blur(4px)" },
  animate: { opacity: 1, filter: "blur(0px)" },
  exit: {
    opacity: 0,
    filter: "blur(4px)",
    transition: { duration: 0.05 },
  },
  transition: { duration: 0.12, delay: 0.08 },
} as const;
const COLLAPSED_CONTENT_FADE_PROPS = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: { duration: 0.05 } },
  transition: { duration: 0.12, delay: 0.18 },
} as const;
const PANEL_RADIUS = 16;

const NETWORK_DEBUG_META_ROW_CLASS =
  "mt-1 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 border-0 p-0 text-[11px] text-text-low";

const NETWORK_DEBUG_META_COPY_CLASS =
  "shrink-0 text-text-low underline decoration-text-low/60 underline-offset-2 hover:text-text-extra-high hover:decoration-text-extra-high";

const NETWORK_DEBUG_PAYLOAD_COPY_BUTTON_CLASS =
  "absolute top-2 right-2 z-10 inline-flex w-fit shrink-0 items-center gap-1 rounded-md border border-border-light bg-white px-2 py-0.5 text-xs font-medium text-text-extra-high shadow-sm hover:bg-gray-100";

function NetworkDebugMetaInterpunct() {
  return (
    <span aria-hidden="true" className="pointer-events-none shrink-0 select-none text-text-low">
      &middot;
    </span>
  );
}

function NetworkDebugPayloadBlock({
  fill,
  label,
  value,
}: {
  fill?: boolean;
  label: string;
  value?: string;
}) {
  const { copied, copy } = useCopy(1200);

  if (!value) {
    return null;
  }

  const formattedValue = formatNetworkDebugPayloadValue(value);

  return (
    <div className={cn("gap-1", fill ? "flex min-h-0 min-w-0 flex-1 flex-col" : "grid min-w-0")}>
      <p className="text-[11px] font-medium text-text-medium">{label}</p>
      <div className={cn("min-w-0", fill && "flex min-h-0 flex-1 flex-col")}>
        <div
          className={cn(
            "relative min-w-0 overflow-hidden rounded-lg bg-border-extra-light",
            fill && "flex min-h-0 flex-1 flex-col"
          )}
        >
          <button
            type="button"
            onClick={() => void copy(formattedValue)}
            className={NETWORK_DEBUG_PAYLOAD_COPY_BUTTON_CLASS}
          >
            {copied ? (
              <CheckIcon className="size-3 shrink-0" />
            ) : (
              <CopyIcon className="size-3 shrink-0" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
          <pre
            className={cn(
              "max-w-full min-h-0 wrap-break-word p-3 pr-14 font-mono text-[11px] whitespace-pre-wrap text-text-extra-high",
              fill
                ? "min-h-0 flex-1 overflow-y-auto overscroll-contain"
                : "max-h-40 shrink-0 overflow-y-auto overscroll-contain"
            )}
          >
            {formattedValue}
          </pre>
        </div>
      </div>
    </div>
  );
}

function NetworkDebugEntryRow({
  entry,
  isSelected,
  onSelect,
}: {
  entry: NetworkDebugEntry;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <motion.li
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16 }}
      className={cn(
        "grid cursor-pointer gap-1 border-b border-border-light px-3 py-2 transition-colors last:border-b-0 hover:bg-border-extra-light",
        isSelected && "bg-border-extra-light"
      )}
    >
      <button type="button" onClick={onSelect} className="grid min-w-0 gap-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded bg-border-extra-light px-1.5 py-0.5 font-mono text-[11px] text-text-medium">
            {entry.method}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-extra-high">
            {entry.path}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px]",
              getNetworkDebugStatusClassName(entry)
            )}
          >
            {entry.state === "pending" ? "pending" : (entry.status ?? entry.state)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] text-text-low">
          <span>{entry.durationMs === undefined ? "pending" : `${entry.durationMs}ms`}</span>
          <span>{new Date(entry.startedAt).toLocaleTimeString()}</span>
        </div>
      </button>
      {entry.error ? (
        <p className="truncate text-[11px] text-status-error-text">{entry.error}</p>
      ) : null}
    </motion.li>
  );
}

export function NetworkDebugToggle() {
  const { available, enabled, pendingCount, setEnabled } = useNetworkDebug();

  if (!available) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      aria-pressed={enabled}
      className="flex h-10 w-full items-center gap-3 rounded-[var(--button-radius-lg)] px-3 text-[16px] leading-[24px] text-text-medium transition-colors hover:bg-border-light hover:text-text-extra-high"
    >
      <span
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors",
          enabled
            ? "border-text-extra-high bg-text-extra-high"
            : "border-border-light bg-border-extra-light"
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            "absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform",
            enabled ? "translate-x-4.5" : "translate-x-0.5"
          )}
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-left">API Debug Logs</span>
      {pendingCount > 0 ? (
        <span className="shrink-0 rounded-full bg-border-extra-light px-1.5 py-0.5 text-[10px] text-text-medium">
          {pendingCount}
        </span>
      ) : null}
    </button>
  );
}

function NetworkDebugExpandedPanel({
  clear,
  entries,
  paused,
  pendingCount,
  selectedEntry,
  setEnabled,
  setIsOpen,
  setPaused,
  setSelectedEntryId,
}: {
  clear: () => void;
  entries: NetworkDebugEntry[];
  paused: boolean;
  pendingCount: number;
  selectedEntry: NetworkDebugEntry | null;
  setEnabled: (enabled: boolean) => void;
  setIsOpen: (open: boolean) => void;
  setPaused: (paused: boolean) => void;
  setSelectedEntryId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  return (
    <motion.div
      key="network-debug-panel"
      layoutId="network-debug-shell"
      layout="position"
      className="pointer-events-auto absolute right-0 bottom-0 flex h-full w-full overflow-hidden rounded-2xl border border-border-light bg-white shadow-lg"
      style={{ borderRadius: PANEL_RADIUS }}
      transition={PANEL_TRANSITION}
    >
      <motion.div className="flex min-h-0 flex-1 flex-col" {...CONTENT_FADE_PROPS}>
        <div className="flex items-start justify-between gap-3 border-b border-border-light px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-text-extra-high">API Debug Logs</h2>
            <p className="text-xs text-text-low">
              {pendingCount} pending, {entries.length - pendingCount} completed
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-text-medium hover:bg-border-extra-light"
          >
            Collapse
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border-light px-4 py-2">
          <Button type="button" onClick={() => setPaused(!paused)} variant="outline" size="xs">
            {paused ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button type="button" onClick={clear} variant="outline" size="xs">
            <EraserIcon className="size-3" />
            Clear
          </Button>
          <Button type="button" onClick={() => setEnabled(false)} variant="destructive" size="xs">
            <BanIcon className="size-3" />
            Disable
          </Button>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-row">
          {entries.length > 0 ? (
            <ul className="h-full min-h-0 w-105 shrink-0 list-none overflow-y-auto overscroll-contain p-0">
              <AnimatePresence initial={false}>
                {entries.map((entry) => (
                  <NetworkDebugEntryRow
                    key={entry.debug_request_id}
                    entry={entry}
                    isSelected={selectedEntry?.debug_request_id === entry.debug_request_id}
                    onSelect={() => setSelectedEntryId(entry.debug_request_id)}
                  />
                ))}
              </AnimatePresence>
            </ul>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-8 text-center text-sm text-text-low">
              No requests captured yet.
            </div>
          )}
          {selectedEntry ? (
            <NetworkDebugEntryDetails
              entry={selectedEntry}
              onClose={() => setSelectedEntryId(null)}
            />
          ) : null}
        </div>
      </motion.div>
    </motion.div>
  );
}

function NetworkDebugEntryDetails({
  entry,
  onClose,
}: {
  entry: NetworkDebugEntry;
  onClose: () => void;
}) {
  const { copied: copiedMeta, copy: copyMeta } = useCopy(1200);
  const metaSummary = formatNetworkDebugMetaSummary(entry);
  const durationPart = entry.durationMs === undefined ? "pending" : `${entry.durationMs}ms`;

  return (
    <aside className="flex h-full min-h-0 w-[320px] shrink-0 flex-col overflow-hidden border-l border-border-light p-3">
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex shrink-0 min-w-0 items-start gap-2">
          <div className="relative min-w-0 flex-1">
            <p className="line-clamp-4 font-mono text-xs text-text-extra-high">{entry.path}</p>
            <fieldset
              aria-label="Request method, duration, copy summary"
              className={NETWORK_DEBUG_META_ROW_CLASS}
            >
              <span className="shrink-0">{entry.method}</span>
              <NetworkDebugMetaInterpunct />
              <span className="min-w-0 tabular-nums">{durationPart}</span>
              <NetworkDebugMetaInterpunct />
              <button
                type="button"
                onClick={() => void copyMeta(metaSummary)}
                className={NETWORK_DEBUG_META_COPY_CLASS}
              >
                {copiedMeta ? "Copied" : "Copy"}
              </button>
            </fieldset>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-text-medium hover:bg-border-extra-light"
          >
            Close
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <NetworkDebugPayloadBlock label="Query" value={entry.query} />
          <NetworkDebugPayloadBlock label="Request body" value={entry.requestBody} />
          <NetworkDebugPayloadBlock fill label="Response" value={entry.responseBody} />
          {!entry.query && !entry.requestBody && !entry.responseBody ? (
            <p className="text-[11px] text-text-low">
              No query, request body, or response captured.
            </p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function NetworkDebugCollapsedButton({
  requestCount,
  setIsOpen,
}: {
  requestCount: number;
  setIsOpen: (open: boolean) => void;
}) {
  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      className="pointer-events-auto absolute right-0 bottom-0 cursor-pointer rounded-2xl px-3 py-2 pr-10 text-sm text-text-extra-high shadow-lg"
    >
      <motion.button
        key="network-debug-pill"
        type="button"
        onClick={() => setIsOpen(true)}
        layoutId="network-debug-shell"
        style={{ borderRadius: PANEL_RADIUS }}
        transition={PANEL_TRANSITION}
      >
        <motion.span {...COLLAPSED_CONTENT_FADE_PROPS}>API Debug Logs</motion.span>
        <motion.span
          {...COLLAPSED_CONTENT_FADE_PROPS}
          className="absolute right-2 rounded-full bg-border-extra-light px-1.5 py-0.5 text-[10px] text-text-medium"
        >
          {requestCount}
        </motion.span>
      </motion.button>
    </Button>
  );
}

export function NetworkDebugPanel() {
  const { available, clear, enabled, entries, paused, pendingCount, setEnabled, setPaused } =
    useNetworkDebug();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const selectedEntry = entries.find((entry) => entry.debug_request_id === selectedEntryId) ?? null;

  if (!available || !enabled) {
    return null;
  }

  return (
    <div
      className={cn(
        "pointer-events-none fixed right-4 bottom-4 z-50 h-[min(calc(100vh-2rem),460px)] transition-[width]",
        selectedEntry ? "w-[min(calc(100vw-2rem),742px)]" : "w-[min(calc(100vw-2rem),422px)]"
      )}
    >
      <AnimatePresence>
        {isOpen ? (
          <NetworkDebugExpandedPanel
            clear={clear}
            entries={entries}
            paused={paused}
            pendingCount={pendingCount}
            selectedEntry={selectedEntry}
            setEnabled={setEnabled}
            setIsOpen={setIsOpen}
            setPaused={setPaused}
            setSelectedEntryId={setSelectedEntryId}
          />
        ) : (
          <NetworkDebugCollapsedButton requestCount={entries.length} setIsOpen={setIsOpen} />
        )}
      </AnimatePresence>
    </div>
  );
}
