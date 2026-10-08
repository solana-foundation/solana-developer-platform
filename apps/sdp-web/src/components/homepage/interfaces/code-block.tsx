import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import styles from "./interfaces.module.css";
import type { CodeLine, CodeToken } from "./snippets";

// Custom property names, kept out of the JSX so they read as style, not copy.
const LINE_INDEX = "--i";
const MIN_ROWS = "--rows";

const TOKEN_CLASS = {
  prompt: styles.prompt,
  key: styles.key,
  value: styles.value,
} as const;

/** Lets a long URL wrap after a slash on a narrow card rather than inside a word. */
function breakable(text: string) {
  const parts = text.split(/(?<=[^/]\/)(?=[^/])/);
  if (parts.length === 1) return text;
  return keyed(parts, "p").map(({ id, item }, index) => (
    <span key={id}>
      {index > 0 && <wbr />}
      {item}
    </span>
  ));
}

function Token({ token }: { token: CodeToken }) {
  if (typeof token === "string") return breakable(token);
  return (
    <span className={TOKEN_CLASS[token.kind]} aria-hidden={token.kind === "prompt" || undefined}>
      {token.text}
    </span>
  );
}

/** Gives each line and token a stable key: the lists are fixed, so position is their identity. */
function keyed<T>(items: readonly T[], prefix: string): { id: string; item: T }[] {
  return items.map((item, position) => ({ id: `${prefix}${position}`, item }));
}

type CodeBlockProps = {
  lines: readonly CodeLine[];
  /** Position of the first line in the card's roll-in, so the answer follows the request. */
  firstIndex: number;
  /** The lines the block keeps room for, so the card holds one height in every mode. */
  rows: number;
  /** Whether the lines roll in now; before that they are in the markup but not painted. */
  rolling: boolean;
  /** The answer rolls in a beat after the request. */
  answer?: boolean;
  className?: string;
};

/**
 * One request or answer as real text in `<pre><code>`, a line at a time so each can rise in after
 * the one before. A line wider than the card wraps instead of scrolling, so nothing hides past
 * its edge. Hand-highlighted rather than `src/lib/shiki-code.tsx`: Shiki highlights on the client
 * after load with the dashboard's theme, while these lines are fixed, server-rendered, roll in one
 * at a time and take only the page's three colours.
 */
export function CodeBlock({
  lines,
  firstIndex,
  rows,
  rolling,
  answer = false,
  className,
}: CodeBlockProps) {
  return (
    <pre className={cn(styles.code, className)} style={{ [MIN_ROWS]: rows } as CSSProperties}>
      <code>
        {keyed(lines, "l").map(({ id, item: line }, index) => (
          <span key={id}>
            {index > 0 && "\n"}
            <span
              className={cn(styles.line, answer && styles.lineAnswer, rolling && styles.lineIn)}
              style={{ [LINE_INDEX]: firstIndex + index } as CSSProperties}
            >
              {keyed(line, "t").map(({ id: tokenId, item: token }) => (
                <Token key={tokenId} token={token} />
              ))}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
}
