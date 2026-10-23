/**
 * A seeded random source for property tests, so a failing case repeats
 * exactly on the next run. xorshift64*, which is plenty for test inputs.
 */
export interface SeededRandom {
  /** A u64 spread over every magnitude: the bit length is drawn first. */
  u64(): bigint;
  /** A whole number in `[0, bound)`. */
  below(bound: number): number;
  /** One of `values`. */
  pick<T>(values: readonly T[]): T;
}

const MASK_64 = (1n << 64n) - 1n;

export function seededRandom(seed: bigint): SeededRandom {
  let state = seed & MASK_64;
  const next = (): bigint => {
    state ^= state >> 12n;
    state ^= (state << 25n) & MASK_64;
    state ^= state >> 27n;
    return (state * 0x2545_f491_4f6c_dd1dn) & MASK_64;
  };
  const below = (bound: number) => Number(next() % BigInt(bound));
  return {
    u64() {
      const bits = BigInt(below(65));
      return bits === 0n ? 0n : next() & ((1n << bits) - 1n);
    },
    below,
    pick(values) {
      return values[below(values.length)];
    },
  };
}
