/**
 * Shorten a long opaque identifier (an address, a mint, a signature) for
 * display: `lead` characters, an ellipsis, then `tail` characters. Every
 * Markets surface spells the middle-ellipsis shape through this one helper so
 * the idiom — and the exact `…` character — is named once; each caller keeps
 * its own lead/tail policy and any gating.
 */
export function truncateMiddle(value: string, lead: number, tail: number): string {
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/**
 * The address shape DvP renders wherever a full base58 address would drown a
 * cell or menu row: 6 characters, an ellipsis, then 4. An address at or under
 * 12 characters passes through untouched, so a short label never gains an
 * ellipsis. Same shape the payments surfaces spell, named once inside Markets.
 */
export function shortenAddress(address: string): string {
  return address.length > 12 ? truncateMiddle(address, 6, 4) : address;
}
