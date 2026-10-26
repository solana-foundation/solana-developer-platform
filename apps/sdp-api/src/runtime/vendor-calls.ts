import { describeError, logEvent } from "./money-path-events";

export const VENDOR_CALL_EVENT = "sdp_api_vendor_call";

export interface VendorCallDetails {
  readonly boundary?: "upstream_http" | "adapter_operation";
  readonly http_status?: number;
  readonly requested_count?: number;
  readonly priced_count?: number;
  readonly confirmed_missing_count?: number;
  readonly invalid_row_count?: number;
  readonly stale_row_count?: number;
  readonly unknown_age_row_count?: number;
  readonly max_snapshot_age_ms?: number;
}

export function logVendorCallFailure(
  vendor: string,
  operation: string,
  error: unknown,
  startedAt?: number,
  details?: VendorCallDetails
): void {
  logEvent("error", {
    event: VENDOR_CALL_EVENT,
    vendor,
    operation,
    outcome: "failed",
    ...(startedAt !== undefined ? { duration_ms: Date.now() - startedAt } : {}),
    ...details,
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
    return await work();
  } catch (error) {
    logVendorCallFailure(vendor, operation, error, startedAt);
    throw error;
  }
}

export function instrumentVendorPort<T extends object>(vendor: string, port: T): T {
  return new Proxy(port, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") {
        return value;
      }
      return function proxied(this: unknown, ...args: unknown[]) {
        const startedAt = Date.now();
        try {
          const result = value.apply(target, args);
          if (result instanceof Promise) {
            return result.catch((error: unknown) => {
              logVendorCallFailure(vendor, prop, error, startedAt);
              throw error;
            });
          }
          return result;
        } catch (error) {
          logVendorCallFailure(vendor, prop, error, startedAt);
          throw error;
        }
      };
    },
  });
}
