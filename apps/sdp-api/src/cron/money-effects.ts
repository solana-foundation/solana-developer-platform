/**
 * Every cron monitor, classified by what it does to money (HOO-1955).
 *
 * - `starts`: can sign or pay out something new. It must say how it is
 *   admitted (`lib/money-admission.ts`, or the HTTP pipeline it re-enters), or
 *   name the gap until its module's admission lands.
 * - `finishes`: completes movement that is already signed or funded. Never
 *   refused: stopping it would strand money (ADR 0002).
 * - `observes`: reads, reconciles bookkeeping, or cleans up. Moves nothing.
 *
 * `Observability.withMonitor` and the managed tick runner only accept these
 * keys, so a new monitor does not typecheck until it is classified here.
 */

export type CronMoneyEffect =
  | {
      effect: "starts";
      admission: { via: "money_admission" } | { via: "http_pipeline" } | { gap: string };
    }
  | { effect: "finishes" }
  | { effect: "observes" };

export const CRON_MONITOR_MONEY_EFFECTS = {
  "sdp-api-collect-recurring-payments": {
    effect: "starts",
    admission: { via: "money_admission" },
  },
  "sdp-api-track-pending-transfers": {
    effect: "starts",
    admission: {
      gap: "In process, this tick also creates BVNK on-ramp payouts (reconcile-bvnk-onramp-payouts.ts) with no admission; the ramps slice adds it.",
    },
  },
  "sdp-api-poll-rings-indexing": {
    effect: "starts",
    admission: {
      gap: "Helius Rings builds and signs proving rows with no admission; it is devnet-only today, and the Rings slice adds it.",
    },
  },
  "sdp-api-reconcile-dvp-trades": { effect: "finishes" },
  "sdp-api-reconcile-earn-vault-movements": { effect: "finishes" },
  "sdp-api-track-pending-withdrawals": { effect: "finishes" },
  "sdp-api-track-pending-deposits": { effect: "observes" },
  "sdp-api-detect-orphaned-earn-split-swaps": { effect: "observes" },
  "sdp-api-sync-earn-catalogue": { effect: "observes" },
  "sdp-api-refresh-earn-metrics": { effect: "observes" },
  "sdp-api-reconcile-revoked-api-key-cache": { effect: "observes" },
  "sdp-api-retire-secrets": { effect: "observes" },
  "sdp-api-cleanup-provider-credential-secrets": { effect: "observes" },
} as const satisfies Record<string, CronMoneyEffect>;

export type CronMonitor = keyof typeof CRON_MONITOR_MONEY_EFFECTS;
