import { hkdfSync } from "node:crypto";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import {
  type Address,
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  type Signature,
  signTransaction,
  type Transaction,
} from "@solana/kit";

/** Devnet's genesis hash. Checked before anything is signed. */
// biome-ignore lint/security/noSecrets: public cluster identifier, not a secret.
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const OWNER_SEED_SALT = "sdp/helius-rings/devnet-e2e/v1";

export interface DevnetConfig {
  readonly rpcUrl: string;
  readonly indexerUrl: string;
  readonly proverUrl: string;
  readonly allowInsecureHttp: boolean;
  readonly seed: Uint8Array;
  /** Classic SPL mint for the token leg; the token leg is skipped without it. */
  readonly splMint: string | undefined;
}

/**
 * Reads the gate's configuration, or returns undefined when the gate is off.
 * Every value is explicit: this test moves real devnet funds, so nothing here
 * falls back to a default.
 */
export function readDevnetConfig(): DevnetConfig | undefined {
  if (process.env.HELIUS_RINGS_DEVNET_E2E !== "1") {
    return undefined;
  }

  const required = {
    rpcUrl: process.env.HELIUS_RINGS_RPC_URL,
    indexerUrl: process.env.HELIUS_RINGS_INDEXER_URL,
    proverUrl: process.env.HELIUS_RINGS_PROVER_URL,
    seed: process.env.HELIUS_RINGS_E2E_SEED,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => value === undefined || value.length === 0)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`HELIUS_RINGS_DEVNET_E2E=1 requires: ${missing.join(", ")}.`);
  }

  const seed = Buffer.from(required.seed as string, "base64");
  if (seed.length !== 32) {
    throw new Error("HELIUS_RINGS_E2E_SEED must be 32 base64-encoded bytes.");
  }

  return {
    rpcUrl: required.rpcUrl as string,
    indexerUrl: required.indexerUrl as string,
    proverUrl: required.proverUrl as string,
    allowInsecureHttp: process.env.HELIUS_RINGS_ALLOW_INSECURE_HTTP === "1",
    seed: new Uint8Array(seed),
    splMint: process.env.HELIUS_RINGS_E2E_SPL_MINT,
  };
}

export interface DevnetOwner {
  readonly index: number;
  readonly address: Address;
  readonly keyPair: CryptoKeyPair;
}

/**
 * Derives a throwaway devnet owner from the gate seed so repeated runs reuse
 * the same funded accounts instead of stranding lamports in fresh ones.
 */
export async function deriveDevnetOwner(seed: Uint8Array, index: number): Promise<DevnetOwner> {
  const secret = new Uint8Array(hkdfSync("sha256", seed, OWNER_SEED_SALT, `owner/${index}`, 32));
  const keyPair = await createKeyPairFromPrivateKeyBytes(secret);

  return {
    index,
    address: await getAddressFromPublicKey(keyPair.publicKey),
    keyPair,
  };
}

export async function assertDevnet(client: ZolanaClient): Promise<void> {
  const genesisHash = await client.solanaRpc.getGenesisHash().send();
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(`Refusing to run: genesis hash ${genesisHash} is not devnet.`);
  }
}

/**
 * Makes sure an owner can pay for the flow, topping up from the faucet when the
 * cluster still has one. A hard failure names the address so it can be funded
 * by hand rather than leaving the test to fail mid-flow.
 */
export async function assertFunded(
  client: ZolanaClient,
  owner: DevnetOwner,
  minimumLamports: bigint
): Promise<void> {
  if ((await client.getBalance(owner.address)) >= minimumLamports) {
    return;
  }

  try {
    await client.solanaRpc.requestAirdrop(owner.address, lamports(minimumLamports * 2n)).send();
  } catch {
    // Helius devnet may not serve the faucet; the balance check below decides.
  }

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if ((await client.getBalance(owner.address)) >= minimumLamports) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(
    `Owner ${owner.index} (${owner.address}) needs at least ${minimumLamports} lamports on devnet.`
  );
}

export interface SubmittedTransaction {
  readonly signature: Signature;
  readonly wireBytes: number;
  readonly elapsedMs: number;
}

/**
 * Signs, simulates, submits, then waits for Photon to index the Rings event.
 *
 * Simulation runs before submission so a malformed build never reaches the
 * cluster. The service will simulate before asking custody to sign, which local
 * key pairs make pointless here. Confirmation goes through the client so a
 * transaction that failed on chain reports a chain error rather than an indexer
 * timeout.
 */
export async function submitAndConfirm(
  client: ZolanaClient,
  transaction: Transaction,
  signers: readonly CryptoKeyPair[],
  options: Readonly<{ indexed: boolean }> = { indexed: true }
): Promise<SubmittedTransaction> {
  const startedAt = Date.now();
  const signed = await signTransaction([...signers], transaction);
  const wire = getBase64EncodedWireTransaction(signed);

  const simulation = await client.solanaRpc
    .simulateTransaction(wire, {
      encoding: "base64",
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();
  if (simulation.value.err !== null) {
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  const signature = getSignatureFromTransaction(signed);
  await client.solanaRpc.sendTransaction(wire, { encoding: "base64" }).send();

  if (options.indexed) {
    await client.confirmPrivateTransaction(signature);
  } else {
    await client.confirmTransaction(signature);
  }

  return {
    signature,
    wireBytes: Buffer.from(wire, "base64").length,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Collects what the gate is meant to report back: sizes and latencies. */
export class FlowLog {
  readonly #rows: Array<{ step: string; bytes: number; ms: number }> = [];

  record(step: string, submitted: SubmittedTransaction): SubmittedTransaction {
    this.#rows.push({ step, bytes: submitted.wireBytes, ms: submitted.elapsedMs });
    return submitted;
  }

  render(): string {
    return this.#rows
      .map((row) => `${row.step.padEnd(28)} ${String(row.bytes).padStart(5)} bytes  ${row.ms} ms`)
      .join("\n");
  }
}
