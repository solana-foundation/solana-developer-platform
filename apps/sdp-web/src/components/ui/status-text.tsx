import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * How a status reads: settled, still moving, needs someone, went wrong, or lapsed without
 * harm. Named for the reading rather than a colour so lists can agree on meaning.
 */
export type StatusTone = "positive" | "progress" | "attention" | "critical" | "neutral";

const TONE_CLASS: Record<StatusTone, string> = {
  positive: "text-success",
  progress: "text-info",
  attention: "text-warning",
  critical: "text-error",
  neutral: "text-secondary",
};

/**
 * A status set as coloured text, no pill: the list's own rhythm carries it, and colour is
 * the only signal a status adds. Pair it with words that stand on their own.
 */
export function StatusText({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return <span className={cn(TONE_CLASS[tone], className)}>{children}</span>;
}
