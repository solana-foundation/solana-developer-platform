import { SdpPaymentsError } from "@sdp/payments/errors";
import { scrubTelemetry } from "@sdp/redaction/scrub";
import { getLogger } from "./logger";

export type MoneyPathEvent = Record<string, unknown> & { event: string };

export function logEvent(level: "info" | "warn" | "error", payload: MoneyPathEvent): void {
  try {
    getLogger()[level](payload, payload.event);
  } catch {
    // Telemetry must never alter a money-path outcome: a denial stays a denial
    // and a breaker trip still throws, even when the logger is unavailable.
  }
}

export function describeError(error: unknown): { error_name: string; error_code?: string } {
  if (!(error instanceof Error)) return { error_name: typeof error };
  const code = (error as { code?: unknown }).code;
  return {
    error_name: error.name,
    error_code: typeof code === "string" ? code : undefined,
  };
}

/**
 * The scrubbed diagnostics a payments error carries: the provider's own
 * wording, which the API never returns. Only ramp-specific logs add these; the
 * shared vendor-call event stays name and code only (EARN-025).
 *
 * @param cause - The thrown value.
 * @returns The scrubbed diagnostics, or undefined when the error carries none.
 */
export function paymentsErrorDiagnostics(cause: unknown): Record<string, unknown> | undefined {
  return cause instanceof SdpPaymentsError && cause.diagnostics !== undefined
    ? scrubTelemetry(cause.diagnostics)
    : undefined;
}
