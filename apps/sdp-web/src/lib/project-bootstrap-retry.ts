export const PROJECT_BOOTSTRAP_RETRY_DELAYS_MS = [0, 250, 500, 750, 1000, 1500, 2000, 2500];
export const PROXY_PROJECT_BOOTSTRAP_RETRY_DELAYS_MS = [0, 250, 500, 750, 1000];

type RetryProjectBootstrapOptions<T> = {
  load: () => Promise<T>;
  isReady: (value: T) => boolean;
  delaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
  shouldRetryError?: (error: unknown) => boolean;
};

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function isRetryableProjectBootstrapError(error: unknown): boolean {
  if (error instanceof TypeError) return true;

  if (error && typeof error === "object" && "status" in error) {
    const status = Number(error.status);
    return status === 404 || status === 409 || status === 425 || status === 429 || status >= 500;
  }

  return false;
}

export async function retryProjectBootstrap<T>({
  load,
  isReady,
  delaysMs = PROJECT_BOOTSTRAP_RETRY_DELAYS_MS,
  wait: waitForDelay = wait,
  shouldRetryError = isRetryableProjectBootstrapError,
}: RetryProjectBootstrapOptions<T>): Promise<T | null> {
  let lastError: unknown;

  for (const delayMs of delaysMs) {
    if (delayMs > 0) await waitForDelay(delayMs);

    try {
      const value = await load();
      lastError = undefined;
      if (isReady(value)) return value;
    } catch (error) {
      if (!shouldRetryError(error)) throw error;
      lastError = error;
      // A new Clerk organization can become active before its SDP records are
      // visible. Keep the navigation pending while the idempotent API fallback
      // or webhook finishes provisioning it.
    }
  }

  if (lastError !== undefined) throw lastError;
  return null;
}
