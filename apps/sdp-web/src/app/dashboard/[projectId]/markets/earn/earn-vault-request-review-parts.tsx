"use client";

import { Loader2Icon } from "lucide-react";

/**
 * The review-step widgets the two asynchronous withdrawal-request modals
 * (solver queue and operator par redemption) render while their preview
 * resolves and when a preview comes back with blocking issues. One copy of
 * each block, so the two modals cannot drift on markup or keys.
 */

/** The role="status" row shown while a preview is being refetched. */
export function VaultRequestPreviewLoading({ label }: { label: string }) {
  return (
    <div className="mt-5 flex items-center gap-2 text-sm text-secondary" role="status">
      <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
      {label}
    </div>
  );
}

/** The preview's blocking issues: why the request cannot be submitted yet. */
export function VaultRequestBlockingIssues({
  notice,
  issues,
}: {
  notice: string;
  issues: readonly { code: string; message: string }[];
}) {
  return (
    <div
      className="mt-4 rounded-lg border border-warning-border bg-warning-bg p-3 text-sm text-warning"
      role="alert"
    >
      <p>{notice}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {issues.map((issue) => (
          <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
        ))}
      </ul>
    </div>
  );
}
