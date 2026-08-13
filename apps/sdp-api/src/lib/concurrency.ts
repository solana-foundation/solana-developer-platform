/**
 * Bounded-concurrency mapping over an item list.
 *
 * Fan-outs to paid upstreams (RPC providers, ramp providers, compliance
 * vendors) must never scale their in-flight request count with attacker- or
 * data-controlled list sizes; this is the shared bound they run through.
 */

/**
 * Maps every item through `mapper`, running at most `concurrency` mappers at
 * a time, and returns per-item settled results in input order.
 *
 * @param items - Items to map.
 * @param concurrency - Maximum simultaneously running mappers.
 * @param mapper - Async transform applied to each item.
 * @returns Settled results aligned to `items` by index.
 */
export async function mapSettledWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>
): Promise<Array<PromiseSettledResult<U>>> {
  const results = new Array<PromiseSettledResult<U>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        try {
          results[currentIndex] = {
            status: "fulfilled",
            value: await mapper(items[currentIndex] as T),
          };
        } catch (reason) {
          results[currentIndex] = {
            status: "rejected",
            reason,
          };
        }
      }
    })
  );

  return results;
}
