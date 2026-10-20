import { isActiveIso4217CurrencyCode } from "@sdp/payments/ramps/shared";
import type {
  ProviderDirectionSupportSnapshot,
  ProviderRailSupportDistillation,
  ProviderRailSupportSnapshot,
} from "@sdp/payments/ramps/types";
import type { CryptoRailId } from "@sdp/types/payment-rails";
import { RAMP_DIRECTIONS, type RampDirection } from "@sdp/types/payments";

/**
 * Share of a direction's committed corridors a refresh may remove. One fiat
 * leaving MoonPay's 33-fiat onramp costs 3% (BRL left its offramp in #2344);
 * a crypto vanishing costs a third.
 */
const MAX_REMOVED_CORRIDOR_SHARE = 0.1;

export interface RailDirectionShrink {
  direction: RampDirection;
  removedCryptos: readonly CryptoRailId[];
  removedCorridors: number;
  committedCorridors: number;
}

export type RailDiscoveryAttempt =
  | { outcome: "requests-failed" }
  | { outcome: "distilled"; distillation: ProviderRailSupportDistillation };

export type GuardedRailDiscovery =
  | RailDiscoveryAttempt
  | { outcome: "shrunk"; shrinks: readonly RailDirectionShrink[] };

function activeFiats(direction: ProviderDirectionSupportSnapshot): string[] {
  return Object.keys(direction.currencies).filter((code) => isActiveIso4217CurrencyCode(code));
}

function directionShrink(
  direction: RampDirection,
  committed: ProviderDirectionSupportSnapshot,
  discovered: ProviderDirectionSupportSnapshot
): RailDirectionShrink {
  const committedFiats = activeFiats(committed);
  const discoveredFiats = new Set(activeFiats(discovered));
  const removedCryptos = committed.cryptos.filter((crypto) => !discovered.cryptos.includes(crypto));
  const keptFiats = committedFiats.filter((fiat) => discoveredFiats.has(fiat)).length;
  const keptCryptos = committed.cryptos.length - removedCryptos.length;
  const committedCorridors = committedFiats.length * committed.cryptos.length;
  return {
    direction,
    removedCryptos,
    removedCorridors: committedCorridors - keptFiats * keptCryptos,
    committedCorridors,
  };
}

/**
 * Directions where a fresh snapshot drops a committed crypto or more than
 * MAX_REMOVED_CORRIDOR_SHARE of the committed (fiat, crypto) corridors.
 * Retired ISO 4217 codes don't count, as the generated matrix drops them.
 */
export function findRailSupportShrink(
  committed: ProviderRailSupportSnapshot,
  discovered: ProviderRailSupportSnapshot
): RailDirectionShrink[] {
  return RAMP_DIRECTIONS.map((direction) =>
    directionShrink(direction, committed[direction], discovered[direction])
  ).filter(
    (shrink) =>
      shrink.removedCryptos.length > 0 ||
      shrink.removedCorridors > shrink.committedCorridors * MAX_REMOVED_CORRIDOR_SHARE
  );
}

export function describeRailSupportShrink(shrinks: readonly RailDirectionShrink[]): string {
  return shrinks
    .map((shrink) => {
      const cryptos =
        shrink.removedCryptos.length > 0 ? ` drops ${shrink.removedCryptos.join(", ")} and` : "";
      return `${shrink.direction}${cryptos} loses ${shrink.removedCorridors} of ${shrink.committedCorridors} corridors`;
    })
    .join("; ");
}

/**
 * Runs one provider's discovery and refuses a shrink against its committed
 * snapshot. A live read retries once before refusing; offline re-distills the
 * same raw dumps, so it compares without retrying. A provider with no
 * committed snapshot, or `allowShrink`, skips the comparison.
 */
export async function discoverWithShrinkGuard(input: {
  committed: ProviderRailSupportSnapshot | undefined;
  allowShrink: boolean;
  offline: boolean;
  discover: () => Promise<RailDiscoveryAttempt>;
  beforeRetry: (shrinks: readonly RailDirectionShrink[]) => Promise<void>;
}): Promise<GuardedRailDiscovery> {
  const { committed } = input;
  if (committed === undefined || input.allowShrink) {
    return input.discover();
  }
  const attempts = input.offline ? 1 : 2;
  let shrinks: readonly RailDirectionShrink[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await input.beforeRetry(shrinks);
    }
    const result = await input.discover();
    if (result.outcome === "requests-failed") {
      return result;
    }
    shrinks = findRailSupportShrink(committed, result.distillation.snapshot);
    if (shrinks.length === 0) {
      return result;
    }
  }
  return { outcome: "shrunk", shrinks };
}
