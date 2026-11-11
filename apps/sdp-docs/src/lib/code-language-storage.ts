/** Reads an optional code-language preference without requiring browser storage. */
export function readCodeLanguage(
  groupId: string,
  persist: boolean | undefined
): string | undefined {
  try {
    const session = window.sessionStorage.getItem(groupId);
    return session ?? (persist ? (window.localStorage.getItem(groupId) ?? undefined) : undefined);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "SecurityError") return undefined;
    throw cause;
  }
}

/** Saves a code-language preference when browser storage is available. */
export function storeCodeLanguage(
  groupId: string,
  value: string,
  persist: boolean | undefined
): void {
  try {
    window.sessionStorage.setItem(groupId, value);
    if (persist) window.localStorage.setItem(groupId, value);
  } catch (cause) {
    if (
      !(
        cause instanceof DOMException &&
        (cause.name === "SecurityError" || cause.name === "QuotaExceededError")
      )
    ) {
      throw cause;
    }
  }
}
