import { createHash } from "node:crypto";

/** Proposed HOO-2303 defaults. See docs/security/data-retention.md. */
export const ACCOUNT_PII_RETENTION_DAYS = 30;

/** Enable only in a reviewed change approving the proposed retention periods. */
export const ACCOUNT_PII_RETENTION_ENFORCED: boolean = false;

/** Stable, non-deliverable replacement; the row's opaque id still joins its history. */
export function pseudonymousEmail(id: string): string {
  return `${createHash("sha256").update(id).digest("hex")}@deleted.invalid`;
}
