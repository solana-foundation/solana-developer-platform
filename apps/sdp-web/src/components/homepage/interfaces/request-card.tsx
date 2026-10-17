"use client";

import { type CSSProperties, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useRiseArrived } from "../rise";
import { CodeBlock } from "./code-block";
import styles from "./interfaces.module.css";
import { type CodeLine, INTERFACE_SNIPPETS, type InterfaceSnippet, responseRows } from "./snippets";

// Custom property names, kept out of the JSX so they read as style, not copy.
const STATUS_DELAY_WIDE = "--status-delay-wide";
const STATUS_DELAY_NARROW = "--status-delay-narrow";

/** The status lands once the answer has rolled in: the lines' 70ms stagger after a 380ms beat. */
function statusDelay(request: readonly CodeLine[], snippet: InterfaceSnippet): string {
  return `${380 + (request.length + snippet.response.length) * 70}ms`;
}

const LAYOUTS = [
  { id: "wide", pick: (snippet: InterfaceSnippet) => snippet.request },
  { id: "narrow", pick: (snippet: InterfaceSnippet) => snippet.narrowRequest },
] as const;

type RequestCardProps = {
  snippet: InterfaceSnippet;
  status: string;
  responseLabel: string;
  /** Whether the lines and status roll in now (the card has arrived on screen). */
  rolling: boolean;
  onArrive: () => void;
};

/**
 * The call and what answers it: the endpoint and status in the head, then the request and the
 * response. Both a wide and a phone layout of the request are rendered and CSS shows one, so the
 * server markup already holds the right text for either screen.
 */
export function RequestCard({
  snippet,
  status,
  responseLabel,
  rolling,
  onArrive,
}: RequestCardProps) {
  const arrived = useRiseArrived();

  useEffect(() => {
    if (arrived !== false) onArrive();
  }, [arrived, onArrive]);

  return (
    <>
      <div className={styles.head}>
        <span className={styles.endpoint}>
          <i>{snippet.method}</i>
          <span>{snippet.path}</span>
        </span>
        <span
          key={snippet.mode}
          className={cn(styles.status, rolling && styles.statusIn)}
          style={
            {
              [STATUS_DELAY_WIDE]: statusDelay(snippet.request, snippet),
              [STATUS_DELAY_NARROW]: statusDelay(snippet.narrowRequest, snippet),
            } as CSSProperties
          }
        >
          <i aria-hidden="true" />
          <span>{status}</span>
        </span>
      </div>
      {LAYOUTS.map((layout) => {
        const request = layout.pick(snippet);
        return (
          <div
            key={`${layout.id}-${snippet.mode}`}
            className={layout.id === "wide" ? styles.wide : styles.narrow}
          >
            <CodeBlock lines={request} firstIndex={0} rows={0} rolling={rolling} />
            <div className={styles.separator}>
              <span>{responseLabel}</span>
            </div>
            <CodeBlock
              lines={snippet.response}
              firstIndex={request.length}
              rows={responseRows(INTERFACE_SNIPPETS, layout.pick, snippet)}
              rolling={rolling}
              answer
              className={styles.response}
            />
          </div>
        );
      })}
    </>
  );
}
