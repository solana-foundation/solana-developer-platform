import { type ExtensionArgs, extension } from "@solana-program/token-2022";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";

const SCALED_UI_AMOUNT_AUTHORITY = syntheticAddress(9_001);

/**
 * A `ScaledUiAmountConfig` extension: UI amounts are base units times `multiplier`, or times
 * `newMultiplier` once the cluster clock reaches `newMultiplierEffectiveTimestamp`.
 *
 * @param scale.multiplier - The multiplier in force before the effective timestamp.
 * @param scale.newMultiplier - The multiplier in force from the effective timestamp on.
 * @param scale.newMultiplierEffectiveTimestamp - The Unix timestamp `newMultiplier` takes over at.
 * @returns The extension, for a mint the test stubs.
 */
export function scaledUiAmountConfig(scale: {
  multiplier: number;
  newMultiplier: number;
  newMultiplierEffectiveTimestamp: bigint;
}): ExtensionArgs {
  return extension("ScaledUiAmountConfig", {
    authority: SCALED_UI_AMOUNT_AUTHORITY,
    multiplier: scale.multiplier,
    newMultiplier: scale.newMultiplier,
    newMultiplierEffectiveTimestamp: scale.newMultiplierEffectiveTimestamp,
  });
}
