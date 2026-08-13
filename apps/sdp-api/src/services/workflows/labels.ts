// Human-friendly label for a workflow trigger/action key (e.g. "token_operation_completed"
// → "Token operation completed"). The dashboard localizes these keys via i18n; this is the
// plain-English equivalent for server-composed text that has no locale — emails, allowlist
// entry labels, and on-chain operation reasons. Keep it in lockstep with the client's
// humanizeType so both surfaces read the same.
export function humanizeWorkflowKey(key: string): string {
  const spaced = key.replace(/_/g, " ").trim();
  if (!spaced) {
    return key;
  }
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`.replace(/\bkyc\b/gi, "KYC");
}
