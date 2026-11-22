export const SAFE_PROXY_CALLERS = ["api", "cron"] as const;

export type SafeProxyCaller = (typeof SAFE_PROXY_CALLERS)[number];
