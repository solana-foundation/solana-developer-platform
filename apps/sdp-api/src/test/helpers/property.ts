import type { Parameters } from "fast-check";

/**
 * fast-check run options for property tests in the ordinary suite. Runs stay
 * at fast-check's default count unless `FC_NUM_RUNS` raises it locally. A
 * failure prints its seed and path; replay it with `FC_SEED=<seed>` (and
 * `FC_PATH=<path>` to jump straight to the shrunk counterexample).
 */
export function propertyParameters<T>(overrides: Parameters<T> = {}): Parameters<T> {
  const seed = process.env.FC_SEED;
  const path = process.env.FC_PATH;
  const numRuns = process.env.FC_NUM_RUNS;
  return {
    ...overrides,
    ...(seed ? { seed: Number(seed) } : {}),
    ...(path ? { path } : {}),
    ...(numRuns ? { numRuns: Number(numRuns) } : {}),
  };
}
