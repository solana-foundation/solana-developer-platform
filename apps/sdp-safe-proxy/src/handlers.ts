import type { SafeProxyHandlers } from "@sdp/safe-proxy-catalog/handlers";

/** One handler per catalog operation. A handler makes at most one outbound call and never retries. */
export const handlers = {
  system: {
    ping: async () => ({ service: "safe-proxy" as const }),
  },
} satisfies SafeProxyHandlers;
