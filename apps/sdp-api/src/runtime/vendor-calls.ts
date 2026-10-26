import { describeError, logEvent } from "./money-path-events";

export const VENDOR_CALL_EVENT = "sdp_api_vendor_call";

function logVendorCallSuccess(vendor: string, operation: string, startedAt: number): void {
  logEvent("info", {
    event: VENDOR_CALL_EVENT,
    vendor,
    operation,
    outcome: "succeeded",
    duration_ms: Date.now() - startedAt,
  });
}

export function logVendorCallFailure(
  vendor: string,
  operation: string,
  error: unknown,
  startedAt?: number
): void {
  logEvent("error", {
    event: VENDOR_CALL_EVENT,
    vendor,
    operation,
    outcome: "failed",
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
            return result.then(
              (value: unknown) => {
                logVendorCallSuccess(vendor, prop, startedAt);
                return value;
              },
              (error: unknown) => {
                logVendorCallFailure(vendor, prop, error, startedAt);
                throw error;
              }
            );
          }
          logVendorCallSuccess(vendor, prop, startedAt);
          return result;
        } catch (error) {
          logVendorCallFailure(vendor, prop, error, startedAt);
          throw error;
        }
      };
    },
  });
}
