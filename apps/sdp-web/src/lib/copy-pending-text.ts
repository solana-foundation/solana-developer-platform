/**
 * Copies text that is still on its way, such as a link only a request's answer names. Safari
 * lets a page write the clipboard only while it handles the press that asked, so a write that
 * starts after an `await` is refused; this one starts at once, with a `ClipboardItem` holding
 * the pending text, and finishes when the text arrives. Call it before the press handler's
 * first `await`.
 *
 * @param text - The text to copy. When it rejects, nothing is written.
 * @returns Whether the text reached the clipboard: false when `text` rejected, the browser
 *   refused the write (as it does for a window without focus), or it has no async clipboard.
 *
 * @example
 * ```ts
 * const copied = copyPendingText(answer.then((res) => linkOf(res)));
 * ```
 */
export async function copyPendingText(text: Promise<string>): Promise<boolean> {
  const contents = text.then((value) => new Blob([value], { type: "text/plain" }));
  // Settling both means a rejected text is seen even when the write never took it.
  const [written] = await Promise.allSettled([startWrite(contents), contents]);
  return written.status === "fulfilled";
}

/** Starts the write in the caller's turn; a browser that cannot write rejects instead. */
async function startWrite(contents: Promise<Blob>): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "text/plain": contents })]);
}
