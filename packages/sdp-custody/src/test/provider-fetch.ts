import { expect, onTestFinished, vi } from "vitest";

/**
 * Spy on `fetch` for a test that queues each provider answer with `mockResolvedValueOnce` (or
 * another `*Once`). A request with no queued answer never reaches the network: it is refused,
 * and the test fails when it finishes, even where the signer swallows the refusal.
 *
 * @returns The spy, to queue answers on and read calls from.
 */
export function stubProviderFetch() {
  const unanswered: string[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const described = `${request.method} ${request.url}`;
    unanswered.push(described);
    throw new Error(`unexpected provider request: ${described}`);
  });
  onTestFinished(() => {
    expect(unanswered, "provider requests with no queued answer").toEqual([]);
  });
  return fetch;
}
