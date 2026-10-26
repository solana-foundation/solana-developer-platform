import { describeError, logEvent } from "./money-path-events";

export const VENDOR_CALL_EVENT = "sdp_api_vendor_call";

type AdapterCallSource = "network" | "shared" | "cache" | "pinned";

export interface VendorCallDetails {
  readonly boundary?: "call_site" | "adapter_operation" | "upstream_http";
  readonly call_source?: AdapterCallSource;
  readonly http_status?: number;
  readonly requested_count?: number;
  readonly priced_count?: number;
  readonly unpriced_count?: number;
  readonly confirmed_missing_count?: number;
  readonly invalid_row_count?: number;
  readonly stale_row_count?: number;
  readonly unknown_age_row_count?: number;
  readonly max_snapshot_age_ms?: number;
}

/** Records one successful vendor operation at the supplied boundary. */
export function logVendorCallSuccess(
  vendor: string,
  operation: string,
  startedAt: number,
  details: VendorCallDetails = { boundary: "call_site" }
): void {
  logEvent("info", {
    event: VENDOR_CALL_EVENT,
    vendor,
    operation,
    outcome: "succeeded",
    ...details,
    duration_ms: Date.now() - startedAt,
  });
}

export function logVendorCallFailure(
  vendor: string,
  operation: string,
  error: unknown,
  startedAt?: number,
  details: VendorCallDetails = { boundary: "call_site" }
): void {
  logEvent("error", {
    event: VENDOR_CALL_EVENT,
    vendor,
    operation,
    outcome: "failed",
    ...details,
    ...(startedAt !== undefined ? { duration_ms: Date.now() - startedAt } : {}),
    ...describeError(error),
  });
}

export async function withVendorCall<T>(
  vendor: string,
  operation: string,
  work: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await work();
    logVendorCallSuccess(vendor, operation, startedAt);
    return result;
  } catch (error) {
    logVendorCallFailure(vendor, operation, error, startedAt);
    throw error;
  }
}

/** Measures adapter operations, which may be served locally or from a cache. */
export function instrumentVendorPort<T extends object>(
  vendor: string,
  port: T,
  sourceForCall?: (operation: string) => AdapterCallSource | undefined
): T {
  return new Proxy(port, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") {
        return value;
      }
      return function proxied(this: unknown, ...args: unknown[]) {
        const startedAt = Date.now();
        let callSource: AdapterCallSource | undefined;
        try {
          callSource = sourceForCall?.(prop);
        } catch {
          // Telemetry metadata must never change the adapter outcome.
        }
        try {
          const result = value.apply(target, args);
          if (result instanceof Promise) {
            return result.then(
              (value: unknown) => {
                logVendorCallSuccess(vendor, prop, startedAt, {
                  boundary: "adapter_operation",
                  call_source: callSource,
                });
                return value;
              },
              (error: unknown) => {
                logVendorCallFailure(vendor, prop, error, startedAt, {
                  boundary: "adapter_operation",
                  call_source: callSource,
                });
                throw error;
              }
            );
          }
          logVendorCallSuccess(vendor, prop, startedAt, {
            boundary: "adapter_operation",
            call_source: callSource,
          });
          return result;
        } catch (error) {
          logVendorCallFailure(vendor, prop, error, startedAt, {
            boundary: "adapter_operation",
            call_source: callSource,
          });
          throw error;
        }
      };
    },
  });
}
