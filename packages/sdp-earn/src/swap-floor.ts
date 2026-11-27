/** An exact amount parsed at the output token's scale by the provider. */
export interface EarnSwapFloorAmount {
  readonly text: string;
  readonly atoms: bigint;
}

/** A quoted or built route cannot cover the caller's approved output floor. */
export class EarnSwapFloorError extends Error {
  readonly name = "EarnSwapFloorError";

  constructor(
    readonly stage: "quote" | "build",
    readonly availableAmount: string
  ) {
    super("The swap cannot guarantee the requested output floor");
  }
}

/**
 * Derive an ExactIn tolerance, then prove the built route's output floor.
 * Providers retain amount parsing, instruction admission and error mapping.
 * A moving quote gets one tighter build at zero tolerance, never another quote.
 */
export async function buildSwapLegWithFloor<T>(input: {
  readonly quote: EarnSwapFloorAmount;
  readonly minimumOutput: bigint;
  readonly assertActive: () => void;
  readonly build: (slippageBps: number) => Promise<{
    readonly value: T;
    readonly minimumOutput: EarnSwapFloorAmount;
  }>;
}): Promise<T> {
  if (input.minimumOutput <= 0n) throw new RangeError("A swap output floor must be positive");
  if (input.quote.atoms < input.minimumOutput)
    throw new EarnSwapFloorError("quote", input.quote.text);

  // Rounding tolerance down rounds the route's guaranteed output up.
  let slippageBps = Math.min(
    Number(((input.quote.atoms - input.minimumOutput) * 10_000n) / input.quote.atoms),
    9_999
  );
  for (;;) {
    input.assertActive();
    const built = await input.build(slippageBps);
    if (built.minimumOutput.atoms >= input.minimumOutput) return built.value;
    if (slippageBps === 0) throw new EarnSwapFloorError("build", built.minimumOutput.text);
    slippageBps = 0;
  }
}
