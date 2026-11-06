import { vi } from "vitest";

/** `ClipboardItem` stand-in (jsdom has none): it keeps what it was handed, pending or not. */
class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

/** What a stubbed clipboard was handed. */
export interface FakeClipboard {
  /** Each write's pending `text/plain`, in call order; a write counts the moment it starts. */
  readonly writes: Promise<Blob>[];
}

/**
 * Stubs the async clipboard as a browser runs it: a write waits for its item's pending text and
 * fails when that text rejects; one the browser `refuses`, as it does a window without focus,
 * fails once the text arrives. Call it after `userEvent.setup()`, which installs a clipboard of
 * its own that takes any write without waiting; `vi.unstubAllGlobals()` takes `ClipboardItem`
 * back, and user-event's next setup replaces the clipboard.
 *
 * @param answer - Whether the browser lets a write land.
 * @returns The writes the clipboard was handed.
 */
export function stubClipboard(answer: "writes" | "refuses"): FakeClipboard {
  const writes: Promise<Blob>[] = [];
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  async function write(items: FakeClipboardItem[]): Promise<void> {
    const [item] = items;
    const contents = item?.items["text/plain"];
    if (contents === undefined) {
      throw new Error("The write held no text/plain.");
    }
    writes.push(contents);
    await contents;
    if (answer === "refuses") {
      throw new DOMException("Document is not focused.", "NotAllowedError");
    }
  }
  Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
  return { writes };
}
