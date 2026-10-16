import type { EarnVaultPositionIntermediate } from "@sdp/types";
import { sumDecimalStrings } from "./earn-market-presentation";

/**
 * A position's whole deposit-token value: its shares plus any par
 * intermediate it still holds (Hastra wYLDS after a cancelled par request).
 * Undefined whenever the shares' own value is, or a figure is malformed.
 */
export function earnVaultHoldingValue(position: {
  tokenValue?: string;
  parIntermediate?: Pick<EarnVaultPositionIntermediate, "tokenValue">;
}): string | undefined {
  if (position.tokenValue === undefined) return undefined;
  if (!position.parIntermediate) return position.tokenValue;
  return sumDecimalStrings([position.tokenValue, position.parIntermediate.tokenValue]);
}
