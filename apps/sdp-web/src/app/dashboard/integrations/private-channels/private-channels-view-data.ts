import type { PrivateChannelTokenEligibility } from "@sdp/types";

export function enabledTokenSymbols(tokens: PrivateChannelTokenEligibility[]): string[] {
  const symbols: string[] = [];
  for (const token of tokens) {
    if (token.enabled) symbols.push(token.symbol);
  }
  return symbols;
}

export function shortenAddress(value: string, visibleCharacters: number): string {
  const shortenedLength = visibleCharacters * 2 + 1;
  return value.length > shortenedLength
    ? `${value.slice(0, visibleCharacters)}…${value.slice(-visibleCharacters)}`
    : value;
}
