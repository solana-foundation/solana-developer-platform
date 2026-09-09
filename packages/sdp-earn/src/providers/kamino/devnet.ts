import { KAMINO_DEVNET_KVAULT_PROGRAM_ID } from "@sdp/types/kamino-programs";
import { internalError } from "../../errors";
import {
  assertRpcServesCluster,
  fromBase64,
  type RpcProgramAccount,
  solanaRpcCall,
  toBase58,
} from "../../solana-rpc";

/**
 * Kamino's DEVNET K-Vault shelf, read on-chain.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * An earlier revision recorded "K-Vaults are mainnet only; there is no devnet
 * deployment" as fact, and built the whole client around it: sandbox was served
 * the mainnet shelf stamped `hostCluster: "mainnet-beta"`, permanently
 * un-fundable. That was WRONG. Measured 2026-08-14:
 *
 * - Kamino runs a devnet kvault program at a DIFFERENT address than mainnet's
 *   (`devkRng…` vs `KvauGM…`), plus klend at the same id as mainnet.
 * - 21 K-Vaults exist on devnet, 9 of them denominated in the official devnet
 *   USDC mint (`4zMMC…`, the one the Circle faucet dispenses), several
 *   deliberately mirroring mainnet names — "Allez USDC", "Steakhouse USDC",
 *   "RockawayX RWA USDC", "Gauntlet Frontier USDC".
 *
 * ── Why on-chain rather than the API ────────────────────────────────────────
 * `api.kamino.finance` indexes MAINNET ONLY, and does so silently: `?env=devnet`
 * and `?cluster=devnet` both return 200 with the byte-identical mainnet payload
 * (verified by hashing the responses), there is no devnet API host, and
 * `/kvaults/vaults/{devnet pubkey}/metrics` answers 404. A parameter that is
 * accepted and ignored is worse than one that errors, so do not "just pass the
 * cluster" — the shelf has to come from the chain.
 *
 * That is why this module speaks JSON-RPC while the mainnet path speaks REST.
 * It still goes through `providerFetchJson`, so timeouts and error taxonomy are
 * the package's, not bespoke.
 */

/**
 * The devnet kvault program. NOT the mainnet id — Kamino deploys a separate
 * program per cluster, and mainnet's id also exists on devnet with ZERO
 * accounts under it, so pointing at the wrong one yields a confident empty
 * shelf rather than an error.
 *
 * Re-exported from `@sdp/types/kamino-programs`, which is the single home for
 * every Kamino program address. It cannot live in `@sdp/kamino` (the package
 * that builds deposit/withdraw instructions against the same program) because
 * this module would then have to import it, and a `@sdp/earn → @sdp/kamino`
 * edge is both a workspace cycle and a reason for the catalogue cron to load a
 * 13MB SDK it never calls.
 *
 * Imported AND re-exported: `listKaminoDevnetVaults` below uses it as a value,
 * which a bare `export … from` would not bind locally.
 */
export { KAMINO_DEVNET_KVAULT_PROGRAM_ID };

/**
 * `VaultState` account size, and the byte offsets of the fields SDP reads.
 *
 * Kamino publishes no IDL through the API and `@sdp/earn` carries no SDK (its
 * only dependency is `@sdp/types`), so these are read positionally. Every value
 * was verified against a live MAINNET account by locating the field values the
 * REST API independently reports for the same vault — the two sources agreeing
 * is what makes the layout a measurement rather than a guess.
 *
 * The size check is the real guard: an Anchor account whose layout changed
 * would almost certainly change length, and `decodeVaultState` additionally
 * validates what it decodes, so a silent layout shift produces dropped rows
 * rather than plausible garbage.
 */
const VAULT_STATE_SIZE = 62_552;
const OFFSET_TOKEN_MINT = 80;
const OFFSET_SHARES_MINT = 184;
const OFFSET_NAME = 58_528;
const NAME_LENGTH = 40;

export interface KaminoDevnetVault {
  /** Vault account address — the catalogue's `providerReference`. */
  address: string;
  name: string;
  tokenMint: string;
  sharesMint: string;
}

/**
 * Decode the fields SDP catalogues, or `null` when the account does not look
 * like a `VaultState`.
 *
 * Fail-closed by design: a program upgrade that moved these fields would emit
 * an unprintable name or an all-zero mint, and admitting that would put a
 * garbage row in front of a customer. Dropping it loses one vault from a
 * sandbox shelf, which is the cheaper mistake.
 */
export function decodeVaultState(address: string, data: Uint8Array): KaminoDevnetVault | null {
  if (data.length !== VAULT_STATE_SIZE) {
    return null;
  }

  const tokenMintBytes = data.subarray(OFFSET_TOKEN_MINT, OFFSET_TOKEN_MINT + 32);
  const sharesMintBytes = data.subarray(OFFSET_SHARES_MINT, OFFSET_SHARES_MINT + 32);
  // An all-zero pubkey is the system program, never a mint — the signature of
  // reading the wrong offset.
  if (tokenMintBytes.every((byte) => byte === 0) || sharesMintBytes.every((byte) => byte === 0)) {
    return null;
  }

  const rawName = data.subarray(OFFSET_NAME, OFFSET_NAME + NAME_LENGTH);
  const terminator = rawName.indexOf(0);
  const nameBytes = terminator === -1 ? rawName : rawName.subarray(0, terminator);
  // Printable ASCII only. Kamino's registry is permissionless, so the name is
  // attacker-chosen free text: SDP may QUOTE it but never parses meaning out of
  // it (see the trust-boundary note in client.ts). Rejecting control bytes is
  // about decode sanity and rendering, not about trusting the content.
  const name = new TextDecoder().decode(nameBytes).trim();
  // Char-code test rather than a control-character regex: the regex form is
  // both lint-flagged and easy to mis-transcribe (a literal control byte in
  // source looks identical to an escape), and this states the intent plainly.
  const hasControlChars = [...name].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (name === "" || hasControlChars) {
    return null;
  }

  return {
    address,
    name,
    tokenMint: toBase58(tokenMintBytes),
    sharesMint: toBase58(sharesMintBytes),
  };
}

/**
 * Every K-Vault on devnet.
 *
 * ALL-OR-NOTHING, matching `_loadMetricsByVault` on the mainnet path and for
 * the same reason: the catalogue sync DELETES rows a provider no longer lists,
 * so a partial read would not degrade gracefully — it would delist the vaults
 * whose page went unread. An RPC failure throws and the sync skips its pass.
 *
 * The genesis proof, the JSON-RPC transport and the base58/base64 helpers are
 * shared with every other on-chain catalogue read (../../solana-rpc.ts); only
 * the layout knowledge below is Kamino's.
 */
export async function listKaminoDevnetVaults(rpcUrl: string): Promise<KaminoDevnetVault[]> {
  await assertRpcServesCluster("kamino", rpcUrl, "devnet");

  const accounts = await solanaRpcCall<RpcProgramAccount[]>(
    "kamino",
    rpcUrl,
    "getProgramAccounts",
    [
      KAMINO_DEVNET_KVAULT_PROGRAM_ID,
      {
        encoding: "base64",
        // Server-side size filter: the program also owns smaller bookkeeping
        // accounts, and shipping only vault states keeps this read at a few
        // hundred KB instead of the whole program's account set.
        filters: [{ dataSize: VAULT_STATE_SIZE }],
      },
    ]
  );

  if (!Array.isArray(accounts)) {
    throw internalError("Kamino devnet vault read returned no result array");
  }

  const vaults: KaminoDevnetVault[] = [];
  for (const account of accounts) {
    const encoded = account.account?.data?.[0];
    if (typeof encoded !== "string") continue;
    const decoded = decodeVaultState(account.pubkey, fromBase64(encoded));
    if (decoded) vaults.push(decoded);
  }

  return vaults;
}
