/** One portfolio request may fan out over many vaults; never fan out the RPCs without a bound. */
export const KAMINO_POSITION_READ_CONCURRENCY = 4;

export async function mapSettledWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  assertActive: () => void,
  mapper: (item: T) => Promise<U>
): Promise<Array<PromiseSettledResult<U>>> {
  const results = new Array<PromiseSettledResult<U>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        // A timed-out aggregate read cannot cancel an in-flight SDK request,
        // but it must never dequeue another vault after the budget expires.
        assertActive();
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = { status: "fulfilled", value: await mapper(items[index] as T) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    })
  );

  return results;
}
