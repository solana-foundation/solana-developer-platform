"use client";

import { cn } from "@sdp/ui/cn";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { type ApiKeyLifetime, formatApiKeyLifetime } from "./api-key-presentation";

/** A lifetime that needs attention leads with a dot: amber while it runs out, grey once ended. */
export function ApiKeyLifetimeText({ lifetime, now }: { lifetime: ApiKeyLifetime; now: number }) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const warn = lifetime.kind === "soon" || lifetime.kind === "stopping";
  const ended = lifetime.kind === "ended";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        warn ? "text-warning" : ended ? "text-tertiary" : "text-secondary"
      )}
    >
      {warn || ended ? (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            warn ? "bg-warning" : "border border-current"
          )}
        />
      ) : null}
      {formatApiKeyLifetime(lifetime, now, locale, timeZone, t)}
    </span>
  );
}
