import type { Parameters } from "fast-check";

/**
 * fast-check run options for property tests in the ordinary suite. Runs stay
 * at fast-check's default count unless `FC_NUM_RUNS` raises it locally. A
 * failure prints its seed and path; replay it with `FC_SEED=<seed>` (and
 * `FC_PATH=<path>` to jump straight to the shrunk counterexample).
 */
export function propertyParameters<T>(overrides?: Parameters<T>): Parameters<T> {
  const parameters: Parameters<T> = { ...overrides };
  const { FC_SEED: seed, FC_PATH: path, FC_NUM_RUNS: numRuns } = process.env;
  if (seed) parameters.seed = Number(seed);
  if (path) parameters.path = path;
  if (numRuns) parameters.numRuns = Number(numRuns);
  return parameters;
}
