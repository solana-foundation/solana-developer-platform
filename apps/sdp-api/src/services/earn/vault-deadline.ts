/** Default ceiling for API-owned vault RPC, provider, and custody calls. */
export const VAULT_EXTERNAL_CALL_TIMEOUT_MS = 20_000;

/**
 * One absolute budget for a vault workflow.
 *
 * Race each awaited external boundary separately through this handle. Racing a
 * whole multi-step async function is unsafe: if its first RPC settles after the
 * timeout, that orphaned function can continue into signing or broadcasting.
 * A thunk also means an already-expired workflow cannot start its next side
 * effect.
 *
 * This bounds caller latency; it cannot cancel an SDK that exposes no
 * AbortSignal. A timed-out broadcast therefore remains ambiguous and must
 * never be treated as a definite failure; callers persist signed intent first.
 */
export class VaultDeadline {
  readonly timeoutMs: number;
  private readonly expiresAt: number;

  constructor(timeoutMs = VAULT_EXTERNAL_CALL_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Vault deadline must be a positive number of milliseconds");
    }
    this.timeoutMs = timeoutMs;
    this.expiresAt = Date.now() + timeoutMs;
  }

  /** Refuse to start another external boundary after this budget expired. */
  assertActive(label: string): void {
    if (this.expiresAt - Date.now() <= 0) throw this.timeoutError(label);
  }

  /** Run one external stage inside the workflow's remaining absolute budget. */
  async run<T>(label: string, operation: () => Promise<T>): Promise<T> {
    this.assertActive(label);
    const remainingMs = this.expiresAt - Date.now();

    // Invoke only after the expiry check. A synchronous throw remains the
    // operation's own error and never gets relabelled as a timeout.
    const pending = operation();
    // SDKs without AbortSignal support may reject after our race is over.
    void pending.catch(() => undefined);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => reject(this.timeoutError(label)), remainingMs);
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private timeoutError(label: string): Error {
    return new Error(`${label} timed out after ${this.timeoutMs}ms`);
  }
}

export function createVaultDeadline(timeoutMs = VAULT_EXTERNAL_CALL_TIMEOUT_MS): VaultDeadline {
  return new VaultDeadline(timeoutMs);
}

/**
 * Backward-compatible convenience for one already-created external operation.
 * Multi-stage workflows must share one `VaultDeadline` and call `run` with
 * thunks so expiry can prevent later work from starting.
 */
export function withVaultDeadline<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = VAULT_EXTERNAL_CALL_TIMEOUT_MS
): Promise<T> {
  return createVaultDeadline(timeoutMs).run(label, () => operation);
}
