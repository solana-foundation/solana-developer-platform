import { currentMinimumRpcSlot, readFloor, readStamp } from "@sdp/rpc/read-context";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { deriveAssociatedTokenAddress } from "@sdp/solana/address";
import { PLUME_PROGRAMS, type PlumeVaultDeployment } from "@sdp/types/plume-programs";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import { address, bytesEqual, getAddressEncoder } from "@solana/kit";
import { getMintDecoder, getTokenDecoder } from "@solana-program/token";
import { oftStoreDecoder } from "./abi";
import { SdpPlumeError } from "./errors";
import { assertPlumeOperationActive } from "./operation";

const TOKEN = SPL_TOKEN_PROGRAMS["spl-token"];
const verifiedMints = new WeakMap<SolanaRpc, Map<string, number>>();

/** One live batch. Cold: 5 accounts; warm: 3 accounts. No account is fetched twice. */
async function readPlumeVaultOnce(
  rpc: SolanaRpc,
  vault: PlumeVaultDeployment,
  owner: string,
  usdc: string
) {
  const shareAta = await deriveAssociatedTokenAddress(owner, vault.shareMint, TOKEN);
  let cached = verifiedMints.get(rpc);
  if (!cached) {
    cached = new Map();
    verifiedMints.set(rpc, cached);
  }
  const mintExpires = cached.get(vault.shareMint);
  const needsMints = mintExpires === undefined || mintExpires < Date.now();
  const keys = [vault.oftStore, vault.tokenEscrow, shareAta];
  if (needsMints) keys.push(vault.shareMint, usdc);
  assertPlumeOperationActive();
  const result = await rpc
    .getMultipleAccounts(keys.map(address), { encoding: "base64", commitment: "confirmed" })
    .send();
  const [store, escrow, holding, shareMint, depositMint] = result.value;
  if (!store || !escrow || store.owner !== PLUME_PROGRAMS.oft || escrow.owner !== TOKEN)
    throw new SdpPlumeError(
      "VAULT_UNREADABLE",
      "Plume vault accounts are missing or have unexpected owners"
    );
  const decoded = oftStoreDecoder.decode(Buffer.from(store.data[0], "base64"));
  const bytes = (v: string) => getAddressEncoder().encode(address(v));
  if (
    !bytesEqual(decoded.discriminator, Uint8Array.of(195, 215, 104, 134, 185, 195, 240, 114)) ||
    !bytesEqual(decoded.mint, bytes(vault.shareMint)) ||
    !bytesEqual(decoded.escrow, bytes(vault.tokenEscrow)) ||
    !bytesEqual(decoded.endpoint, bytes(PLUME_PROGRAMS.endpoint)) ||
    decoded.rate !== 10n ** BigInt(Math.max(0, vault.shareDecimals - vault.plumeShareDecimals))
  )
    throw new SdpPlumeError(
      "VAULT_UNREADABLE",
      "Plume OFT store differs from its approved deployment"
    );
  const escrowToken = getTokenDecoder().decode(Buffer.from(escrow.data[0], "base64"));
  if (escrowToken.mint !== vault.shareMint || escrowToken.owner !== vault.oftStore)
    throw new SdpPlumeError(
      "VAULT_UNREADABLE",
      "Plume escrow identity differs from its approved deployment"
    );
  if (needsMints) {
    if (!shareMint || !depositMint || shareMint.owner !== TOKEN || depositMint.owner !== TOKEN)
      throw new SdpPlumeError("VAULT_UNREADABLE", "Plume mint identity is unavailable");
    const shares = getMintDecoder().decode(Buffer.from(shareMint.data[0], "base64"));
    const deposit = getMintDecoder().decode(Buffer.from(depositMint.data[0], "base64"));
    if (
      !shares.isInitialized ||
      shares.decimals !== vault.shareDecimals ||
      !deposit.isInitialized ||
      deposit.decimals !== 6
    )
      throw new SdpPlumeError(
        "VAULT_UNREADABLE",
        "Plume mint decimals differ from the approved deployment"
      );
    cached.set(vault.shareMint, Date.now() + 300_000);
  }
  if (holding === null) return { shareAta, shares: 0n, shareAccountExists: false };
  if (holding === undefined || holding.owner !== TOKEN)
    throw new SdpPlumeError("VAULT_UNREADABLE", "Plume holding has an unexpected owner");
  const token = getTokenDecoder().decode(Buffer.from(holding.data[0], "base64"));
  if (token.mint !== vault.shareMint || token.owner !== owner)
    throw new SdpPlumeError(
      "VAULT_UNREADABLE",
      "Plume holding identity differs from the requested wallet"
    );
  return { shareAta, shares: token.amount, shareAccountExists: true };
}

const inFlightReads = new WeakMap<SolanaRpc, Map<string, SharedPlumeRead>>();

interface SharedPlumeRead {
  /** `readStamp()` taken before the request was sent. */
  stamp: number;
  /** The sender's minimum-slot scope, if any: a scoped read never shares. */
  minimumSlot?: number;
  response: Promise<Awaited<ReturnType<typeof readPlumeVaultOnce>>>;
}

/**
 * Whether the current caller may join an in-flight shared read. A caller with
 * a minimum-slot scope always sends its own request, so the context-aware
 * transport validates its own scope, and no caller joins one sent before its
 * read floor. Only unscoped live reads share.
 */
function canJoinPlumeRead(entry: SharedPlumeRead): boolean {
  if (currentMinimumRpcSlot() !== undefined || entry.minimumSlot !== undefined) return false;
  const floor = readFloor();
  return floor === undefined || entry.stamp > floor;
}

/** Share only unscoped concurrent identical reads; each subsequent operation reads live holdings. */
export function readPlumeVault(
  rpc: SolanaRpc,
  vault: PlumeVaultDeployment,
  owner: string,
  usdc: string
) {
  let reads = inFlightReads.get(rpc);
  if (!reads) {
    reads = new Map();
    inFlightReads.set(rpc, reads);
  }
  const key = `${vault.shareMint}:${owner}:${usdc}`;
  const existing = reads.get(key);
  if (existing && canJoinPlumeRead(existing)) return existing.response;
  const entry: SharedPlumeRead = {
    stamp: readStamp(),
    minimumSlot: currentMinimumRpcSlot(),
    response: readPlumeVaultOnce(rpc, vault, owner, usdc).finally(() => {
      if (reads.get(key) === entry) reads.delete(key);
    }),
  };
  reads.set(key, entry);
  return entry.response;
}
