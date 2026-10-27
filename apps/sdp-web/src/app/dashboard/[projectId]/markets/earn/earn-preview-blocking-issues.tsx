"use client";

import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";

/**
 * The one review-step warning box an async-withdrawal preview raises for its
 * blocking issues: the flow's own intro line, then every issue the provider
 * reported, so a blocked request is explained rather than silently disabled.
 */
export function EarnPreviewBlockingIssues({
  introKey,
  issues,
}: {
  introKey: MessageKey;
  issues: ReadonlyArray<{ code: string; message: string }>;
}) {
  const t = useTranslations();
  return (
    <div
      className="mt-4 rounded-lg border border-warning-border bg-warning-bg p-3 text-sm text-warning"
      role="alert"
    >
      <p>{t(introKey)}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {issues.map((issue) => (
          <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
        ))}
      </ul>
    </div>
  );
}
