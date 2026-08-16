/** Default ceiling for API-owned vault RPC, provider, and custody calls. */
export const VAULT_EXTERNAL_CALL_TIMEOUT_MS = 20_000;

/**
 * Bound an external call even when its SDK does not expose an AbortSignal.
 * Consume a late rejection so a timed-out operation cannot become unhandled.
 */
export async function withVaultDeadline<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = VAULT_EXTERNAL_CALL_TIMEOUT_MS
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  void operation.catch(() => undefined);

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
