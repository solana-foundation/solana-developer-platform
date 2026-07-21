export const PROJECT_BOOTSTRAP_RETRY_DELAYS_MS = [0, 250, 500, 750, 1000, 1500, 2000, 2500];

type RetryProjectBootstrapOptions<T> = {
  load: () => Promise<T>;
  isReady: (value: T) => boolean;
  delaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
};

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function retryProjectBootstrap<T>({
  load,
  isReady,
  delaysMs = PROJECT_BOOTSTRAP_RETRY_DELAYS_MS,
  wait: waitForDelay = wait,
}: RetryProjectBootstrapOptions<T>): Promise<T | null> {
  for (const delayMs of delaysMs) {
    if (delayMs > 0) await waitForDelay(delayMs);

    try {
      const value = await load();
      if (isReady(value)) return value;
    } catch {
      // A new Clerk organization can become active before its SDP records are
      // visible. Keep the navigation pending while the idempotent API fallback
      // or webhook finishes provisioning it.
    }
  }

  return null;
}
