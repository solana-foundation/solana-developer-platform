import { KAMINO_DEVNET_KVAULT_PROGRAM_ID } from "@sdp/types/kamino-programs";
import { internalError, providerNotConfigured } from "../../errors";
import { providerFetchJson } from "../../fetch";

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

const RPC_TIMEOUT_MS = 20_000;

/**
 * Solana devnet's genesis hash — the chain's own identity, checked before any
 * vault is read.
 *
 * This exists because `EarnRuntimeContext.environment` is a PER-PROJECT
 * attribute while `ctx.env` is the PROCESS environment, and `syncEarnCatalogue`
 * walks both environments inside one process with one env object. A production
 * deployment therefore reaches this code with `SOLANA_RPC_URL` pointing at
 * MAINNET while syncing the sandbox environment. Without this check the devnet
 * program id would be queried against mainnet, return zero accounts, and hand
 * back a confident empty shelf — which is also the one shape that makes the
 * sync skip its delist pass, so sandbox would silently freeze on whatever it
 * last held.
 *
 * It also makes `hostCluster: "devnet"` a measurement rather than a derivation.
 * Migration 0057's whole point is that the environment must never be assumed to
 * imply the cluster; asserting the chain we actually read is how this path
 * honours that rather than quietly re-introducing the assumption.
 */
// biome-ignore lint/security/noSecrets: Solana devnet's public genesis hash
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export interface KaminoDevnetVault {
  /** Vault account address — the catalogue's `providerReference`. */
  address: string;
  name: string;
  tokenMint: string;
  sharesMint: string;
}

interface RpcAccount {
  pubkey: string;
  account: { data: [string, string] };
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

interface RpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

// biome-ignore lint/security/noSecrets: the bitcoin/Solana base58 alphabet
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encode 32 raw bytes as base58. Hand-rolled because pulling `@solana/*` into
 * this package for one function would give it its first non-`@sdp` dependency.
 */
function toBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }

  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    value /= 58n;
    encoded = BASE58_ALPHABET[remainder] + encoded;
  }

  // Leading zero bytes are significant and carry no value in the integer above:
  // each encodes as '1'. Dropping them yields a shorter string that decodes to
  // a DIFFERENT address, which would silently mis-key a vault.
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }

  return encoded === "" ? "1" : encoded;
}

/** `atob` rather than `Buffer`, so this stays runtime-agnostic. */
function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
 */
async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await providerFetchJson<RpcResponse<T>, JsonRpcRequest>("kamino", rpcUrl, {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method, params },
    timeoutMs: RPC_TIMEOUT_MS,
  });

  // JSON-RPC reports failure inside a 200 body, so the HTTP layer above cannot
  // see it. Without this an errored read looks like an empty shelf — the exact
  // shape that would delist every Kamino row.
  if (response.error) {
    throw internalError(
      `Kamino devnet ${method} failed: ${response.error.message ?? "unknown RPC error"}`
    );
  }
  if (response.result === undefined) {
    throw internalError(`Kamino devnet ${method} returned no result`);
  }
  return response.result;
}

export async function listKaminoDevnetVaults(rpcUrl: string): Promise<KaminoDevnetVault[]> {
  if (rpcUrl.trim() === "") {
    throw providerNotConfigured("Kamino devnet catalogue needs a Solana RPC URL");
  }

  const genesisHash = await rpcCall<string>(rpcUrl, "getGenesisHash", []);
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw providerNotConfigured(
      `Kamino devnet catalogue requires a devnet RPC; ${rpcUrl} reports genesis ${genesisHash}`
    );
  }

  // `providerFetchJson` serializes the body and sets the JSON headers itself,
  // so the request object goes in as a value rather than pre-stringified.
  const accounts = await rpcCall<RpcAccount[]>(rpcUrl, "getProgramAccounts", [
    KAMINO_DEVNET_KVAULT_PROGRAM_ID,
    {
      encoding: "base64",
      // Server-side size filter: the program also owns smaller bookkeeping
      // accounts, and shipping only vault states keeps this read at a few
      // hundred KB instead of the whole program's account set.
      filters: [{ dataSize: VAULT_STATE_SIZE }],
    },
  ]);

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
