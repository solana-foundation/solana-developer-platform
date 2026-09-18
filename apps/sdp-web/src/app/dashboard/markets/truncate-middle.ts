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
