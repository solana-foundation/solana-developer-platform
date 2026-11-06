"use client";

import { cn } from "@sdp/ui/cn";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { type ApiKeyLifetime, formatApiKeyLifetime } from "./api-key-presentation";

type LifetimeTone = { text: string; dot: string | null };

function lifetimeTone(kind: ApiKeyLifetime["kind"]): LifetimeTone {
  switch (kind) {
    case "soon":
    case "stopping":
      return { text: "text-warning", dot: "bg-warning" };
    case "ended":
      return { text: "text-tertiary", dot: "border border-current" };
    case "never":
    case "until":
      return { text: "text-secondary", dot: null };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown API key lifetime: ${String(exhaustive)}`);
    }
  }
}

/** A lifetime that needs attention leads with a dot: amber while it runs out, grey once ended. */
export function ApiKeyLifetimeText({ lifetime, now }: { lifetime: ApiKeyLifetime; now: number }) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const tone = lifetimeTone(lifetime.kind);
  return (
    <span className={cn("inline-flex items-center gap-1.5", tone.text)}>
      {tone.dot ? (
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
      ) : null}
      {formatApiKeyLifetime(lifetime, now, locale, timeZone, t)}
    </span>
  );
}
