import { scrubTelemetry } from "@sdp/redaction/scrub";
import pino from "pino";
import type { SafeProxyCaller } from "./endpoints/callers";

export interface RequestLogLine {
  request_id: string;
  caller: SafeProxyCaller | null;
  provider: string | null;
  cluster: string | null;
  endpoint: string | null;
  error: string | null;
  status: number;
  duration_ms: number;
}

const REQUEST_EVENT = "sdp_safe_proxy_request";

const SEVERITY = { info: "INFO", warn: "WARNING", error: "ERROR" } as const;

export const logger = pino({
  base: undefined,
  messageKey: "message",
  hooks: {
    logMethod(args, method) {
      // SAFETY: the scrubber returns each argument with its type unchanged.
      method.apply(this, args.map((argument) => scrubTelemetry(argument)) as typeof args);
    },
  },
});

function levelFor(status: number): keyof typeof SEVERITY {
  if (status >= 500) return "error";
  return status >= 400 ? "warn" : "info";
}

export function logRequest(line: RequestLogLine): void {
  const level = levelFor(line.status);
  logger[level]({ event: REQUEST_EVENT, severity: SEVERITY[level], ...line }, REQUEST_EVENT);
}
