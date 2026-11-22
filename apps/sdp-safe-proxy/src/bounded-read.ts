const DEADLINE_PASSED = "deadline_passed";

export type DeadlinePassed = typeof DEADLINE_PASSED;

// Settles once, when the request's deadline passes; it never rejects.
export function deadlinePassed(deadline: AbortSignal): Promise<DeadlinePassed> {
  return new Promise((resolve) => {
    if (deadline.aborted) resolve(DEADLINE_PASSED);
    else deadline.addEventListener("abort", () => resolve(DEADLINE_PASSED), { once: true });
  });
}

export function isDeadlinePassed<Value>(
  settled: Value | DeadlinePassed
): settled is DeadlinePassed {
  return settled === DEADLINE_PASSED;
}

export type BoundedRead =
  | { read: "complete"; bytes: Uint8Array }
  | { read: "too_large" }
  | { read: "deadline_passed" };

// Reads a stream to its end, stopping at the size limit or the deadline, whichever comes first.
// A read that stops early cancels the stream.
export async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  passed: Promise<DeadlinePassed>
): Promise<BoundedRead> {
  if (stream === null) return { read: "complete", bytes: new Uint8Array() };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await Promise.race([reader.read(), passed]);
    if (isDeadlinePassed(next)) {
      await reader.cancel();
      return { read: "deadline_passed" };
    }
    if (next.done) return { read: "complete", bytes: Buffer.concat(chunks) };
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { read: "too_large" };
    }
    chunks.push(next.value);
  }
}
