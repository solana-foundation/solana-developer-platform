export const payQueryKeys = {
  /** The payer's browser reading an open payment link again. */
  linkStatus: (statusUrl: string) => ["pay-link-status", statusUrl] as const,
};
