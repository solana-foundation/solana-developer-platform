import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { address, getAddressEncoder } from "@solana/kit";
import type { WisdomTreeChainReader } from "./chain";
import { TRANSFER_HOOK_EXECUTE_DISCRIMINATOR } from "./transfer-hook";

/**
 * The LIVE WTGXX mint account, captured verbatim from mainnet-beta on
 * 2026-08-28 (`getAccountInfo Em46fxx…`, base64). Real bytes on purpose: the
 * mint parser and the build-time verification are tested against the exact
 * account the production path will read, not a hand-built approximation.
 */
export const WTGXX_MINT_ACCOUNT_BASE64 =
  // biome-ignore lint/security/noSecrets: a public on-chain account snapshot, not a credential
  "AQAAAB2xnEqSO8sZPGeQEhmQ3X+IzhAbQLpJPMnVWbA7sPSP8mss1wgAAAAJAQEAAABzwlqNUhBgDnyX+YoPa5Wi0md+4WM6nid/A/8VcEEz0wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQAAPuJ2FTwKjm2ceUyKz9jasrbpf1dVq06bCcHiC7tAl/cxw/QLM7rMhcoPZgn6ttq9HO8Ub2ACWfUePx93M9ItcGQA4AA+4nYVPAqObZx5TIrP2Nqytul/V1WrTpsJweILu0CX9AAAAAAAA8D8AAAAAAAAAAAAAAAAAAPA/GgAhADPnFWqaIb56oewidAqLHfWwauBugPTClN7oWn2AHJOWAAwAIAAPuJ2FTwKjm2ceUyKz9jasrbpf1dVq06bCcHiC7tAl/Q4AQAAPuJ2FTwKjm2ceUyKz9jasrbpf1dVq06bCcHiC7tAl/dEFsuk4srWpLVcZMSkBnjwGNmWaz3RcDYmrDPu6DxFQEwDhAA+4nYVPAqObZx5TIrP2Nqytul/V1WrTpsJweILu0CX9zHD9AszusyFyg9mCfq22r0c7xRvYAJZ9R4/H3cz0i1wvAAAAV2lzZG9tVHJlZSBHb3Zlcm5tZW50IE1vbmV5IE1hcmtldCBEaWdpdGFsIEZ1bmQFAAAAV1RHWFhdAAAAaHR0cHM6Ly9nYXRld2F5LnBpbmF0YS5jbG91ZC9pcGZzL2JhZmtyZWlobm5oeWx6aGtjaXV3aWs1aG4yNW1nbGFpZ3hsc2plcXZ3NWxtcG1wdTNpb3lvZTMyeTc0AAAAAA==";

export function wtgxxMintAccountData(): Uint8Array {
  return Uint8Array.from(Buffer.from(WTGXX_MINT_ACCOUNT_BASE64, "base64"));
}

/** A minimal 165-byte SPL token-account image holding `baseUnits` (u64 LE at offset 64). */
export function tokenAccountData(baseUnits: bigint): Uint8Array {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, baseUnits, true);
  return data;
}

/** Serialize an ExtraAccountMetaList validation-account image: TLV header + count + entries. */
export function extraAccountMetaListAccount(entries: Uint8Array[]): Uint8Array {
  const body = new Uint8Array(4 + entries.length * 35);
  new DataView(body.buffer).setUint32(0, entries.length, true);
  entries.forEach((entry, index) => {
    body.set(entry, 4 + index * 35);
  });
  const data = new Uint8Array(12 + body.length);
  data.set(TRANSFER_HOOK_EXECUTE_DISCRIMINATOR, 0);
  new DataView(data.buffer).setUint32(8, body.length, true);
  data.set(body, 12);
  return data;
}

/** A literal (fixed pubkey) ExtraAccountMeta entry. */
export function literalHookEntry(
  pubkey: string,
  flags: { isSigner?: boolean; isWritable?: boolean } = {}
): Uint8Array {
  const entry = new Uint8Array(35);
  entry[0] = 0;
  entry.set(getAddressEncoder().encode(address(pubkey)), 1);
  entry[33] = flags.isSigner ? 1 : 0;
  entry[34] = flags.isWritable ? 1 : 0;
  return entry;
}

/**
 * Fake chain reader keyed by address. Addresses absent from `accounts` read as
 * nonexistent; `reads` records the order for assertions.
 */
export function fakeReader(
  accounts: Record<string, { owner?: string; data: Uint8Array }>
): WisdomTreeChainReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async getAccount(accountAddress) {
      reads.push(String(accountAddress));
      const entry = accounts[String(accountAddress)];
      if (!entry) return null;
      return { owner: entry.owner ?? SPL_TOKEN_PROGRAMS["spl-token"], data: entry.data };
    },
  };
}
