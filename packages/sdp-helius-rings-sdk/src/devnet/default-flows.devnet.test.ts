import { SOL_MINT, Wallet } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import {
  backfillAssetRegistry,
  buildDepositTransaction,
  buildMergeTransaction,
  buildRegistrationTransaction,
  buildSetMergingEnabledTransaction,
  buildTransferTransaction,
  buildWithdrawalTransaction,
  fetchUserRecord,
  getPrivateTransactions,
  syncWallet,
} from "@heliuslabs/zolana/wallet";
import type { PrivateOperation } from "@sdp/helius-rings";
import {
  address,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  MAX_COMPUTE_UNIT_LIMIT,
} from "@solana-program/compute-budget";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CustodyWalletAuthority } from "../authority.js";
import { createRingsClient } from "../client.js";
import { deriveMaterial } from "../deterministic-ka/index.js";
import { SDP_NATIVE_MINT } from "../flows/mint.js";
import { createRingsGateway } from "../gateway.js";
import { canonicalShieldedIdentity, type ShieldedMaterial } from "../material.js";
import {
  assertDevnet,
  assertFunded,
  DEVNET_IDENTITY_VERSION,
  type DevnetConfig,
  type DevnetOwner,
  deriveDevnetOwner,
  FlowLog,
  readDevnetConfig,
  submitAndConfirm,
} from "./harness.js";

/**
 * The Phase 1 feasibility gate.
 *
 * It answers one question that decides the whole integration: can an identity
 * whose viewing and nullifier keys were derived outside the custodian still
 * register, receive, spend and merge? If it cannot, no amount of service
 * plumbing helps and the constraint goes back to Helius.
 *
 * It moves real devnet funds, so it only runs with HELIUS_RINGS_DEVNET_E2E=1.
 */
const config = readDevnetConfig();
const gate = config === undefined ? describe.skip : describe.sequential;

/**
 * Vitest still runs file-level hooks for a skipped suite, so the config cannot
 * be narrowed once and reused. This throws rather than asserting: reaching it
 * with the gate off is a gating bug, not a skip.
 */
function requireConfig(): DevnetConfig {
  if (config === undefined) {
    throw new Error("The Rings devnet gate ran without HELIUS_RINGS_DEVNET_E2E=1.");
  }

  return config;
}

const SHIELD_LAMPORTS = 20_000_000n;
const TRANSFER_LAMPORTS = 5_000_000n;
const WITHDRAW_LAMPORTS = 2_000_000n;
const MINIMUM_OWNER_LAMPORTS = 200_000_000n;

const SOL = address(SOL_MINT);
const DERIVATION_SCOPE = {
  organizationId: "devnet-e2e",
  projectId: `default-flows-${DEVNET_IDENTITY_VERSION}`,
} as const;

function walletId(index: number): string {
  return `owner-${index}`;
}

interface Identity {
  readonly owner: DevnetOwner;
  readonly material: ShieldedMaterial;
  readonly wallet: Wallet;
}

let client: ZolanaClient;
let sender: Identity;
let recipient: Identity;
const log = new FlowLog();

function authorityFor(identity: Identity, operationId: string): CustodyWalletAuthority {
  return new CustodyWalletAuthority({
    material: identity.material,
    authorization: {
      owner: identity.owner.address,
      operationId,
      intentKey: `devnet-e2e:${identity.owner.index}:${operationId}`,
    },
  });
}

/**
 * Refreshes one Wallet from the indexer. The suite intentionally retains that
 * Wallet between flow tests; the explicit fresh-wallet test below covers the
 * restart behavior that this helper alone cannot.
 */
async function sync(identity: Identity): Promise<void> {
  const authority = authorityFor(identity, "sync");
  let report = await syncWallet({ wallet: identity.wallet, authority, client });

  if (report.unknownAssetIds.length > 0 || report.unknownAssetFields.length > 0) {
    await backfillAssetRegistry(identity.wallet, client);
    report = await syncWallet({ wallet: identity.wallet, authority, client });
  }

  expect(report.unparsedTransactions).toBe(0);
  expect(report.undecryptableCandidates).toBe(0);
}

function solBalance(identity: Identity): bigint {
  return identity.wallet.balance(SOL).amount;
}

function unspentSolNotes(identity: Identity): number {
  return identity.wallet.utxos().filter((entry) => !entry.spent && entry.utxo.asset === SOL).length;
}

async function buildIdentity(index: number): Promise<Identity> {
  const { seed } = requireConfig();
  const owner = await deriveDevnetOwner(seed, index);
  const material = await deriveMaterial(seed, {
    ...DERIVATION_SCOPE,
    walletId: walletId(index),
    owner: owner.address,
  });

  return { owner, material, wallet: new Wallet({ identity: material.shieldedAddress }) };
}

/** Registration is idempotent: an existing record with our keys is a no-op. */
async function ensureRegistered(identity: Identity): Promise<void> {
  const existing = await fetchUserRecord({ rpc: client, owner: identity.owner.address });

  if (existing !== undefined) {
    expect(existing.nullifierPublicKey).toStrictEqual(identity.material.nullifierKey.publicKey());
    expect(existing.viewingPublicKey).toStrictEqual(
      identity.material.viewingKey.publicKey().toBytes()
    );
  } else {
    const transaction = await buildRegistrationTransaction({
      client,
      owner: identity.owner.address,
      address: identity.material.shieldedAddress,
    });
    expect(transaction).toBeDefined();
    log.record(
      `register/${identity.owner.index}`,
      await submitAndConfirm(
        client,
        transaction as NonNullable<typeof transaction>,
        [identity.owner.keyPair],
        { indexed: false }
      )
    );
  }

  const record = await fetchUserRecord({ rpc: client, owner: identity.owner.address });
  expect(record?.owner).toBe(identity.owner.address);

  if (record?.mergingEnabled !== true) {
    log.record(
      `enable-merging/${identity.owner.index}`,
      await submitAndConfirm(
        client,
        await buildSetMergingEnabledTransaction({
          client,
          owner: identity.owner.address,
          enabled: true,
        }),
        [identity.owner.keyPair],
        { indexed: false }
      )
    );
    expect(
      (await fetchUserRecord({ rpc: client, owner: identity.owner.address }))?.mergingEnabled
    ).toBe(true);
  }
}

async function shield(identity: Identity, amount: bigint, label: string): Promise<void> {
  log.record(
    label,
    await submitAndConfirm(
      client,
      await buildDepositTransaction({
        client,
        feePayer: identity.owner.address,
        recipient: identity.material.shieldedAddress,
        amount,
      }),
      [identity.owner.keyPair]
    )
  );
}

beforeAll(async () => {
  if (config === undefined) {
    return;
  }

  client = await createRingsClient({
    solanaRpcUrl: config.rpcUrl,
    indexerUrl: config.indexerUrl,
    proverUrl: config.proverUrl,
    allowInsecureHttp: config.allowInsecureHttp,
  });

  await assertDevnet(client);

  sender = await buildIdentity(0);
  recipient = await buildIdentity(1);

  await assertFunded(client, sender.owner, MINIMUM_OWNER_LAMPORTS);
  await assertFunded(client, recipient.owner, MINIMUM_OWNER_LAMPORTS);
});

afterAll(() => {
  sender?.material.destroy();
  recipient?.material.destroy();
  const rendered = log.render();
  if (rendered.length > 0) {
    console.log(`\nRings devnet flow report\n${rendered}\n`);
  }
});

gate("Rings default flows on devnet", () => {
  it("derives a stable identity for each owner", () => {
    expect(canonicalShieldedIdentity(sender.material.shieldedAddress)).not.toBe(
      canonicalShieldedIdentity(recipient.material.shieldedAddress)
    );
    expect(sender.material.shieldedAddress.solanaAddress()).toBe(sender.owner.address);
  });

  it("registers both identities with independently derived keys and enables merging", async () => {
    await ensureRegistered(sender);
    await ensureRegistered(recipient);
  });

  it("shields SOL and reflects the exact private balance", async () => {
    await sync(sender);
    const before = solBalance(sender);

    await shield(sender, SHIELD_LAMPORTS, "shield/sol");

    await sync(sender);
    expect(solBalance(sender)).toBe(before + SHIELD_LAMPORTS);
  });

  it("transfers privately to a registered recipient", async () => {
    await sync(sender);
    await sync(recipient);
    const senderBefore = solBalance(sender);
    const recipientBefore = solBalance(recipient);

    const authority = authorityFor(sender, "transfer_registered");
    const transaction = await buildTransferTransaction({
      client,
      wallet: sender.wallet,
      authority,
      feePayer: sender.owner.address,
      recipient: recipient.owner.address,
      amount: TRANSFER_LAMPORTS,
    });

    // Every private builder asks for approval; a build that never asked would
    // mean the service could spend without SDP having authorized anything.
    expect(authority.approvedSummaries().length).toBeGreaterThan(0);

    log.record(
      "transfer/registered",
      await submitAndConfirm(client, transaction, [sender.owner.keyPair])
    );

    await sync(sender);
    await sync(recipient);
    expect(solBalance(sender)).toBe(senderBefore - TRANSFER_LAMPORTS);
    expect(solBalance(recipient)).toBe(recipientBefore + TRANSFER_LAMPORTS);
  });

  it("builds and submits a withdrawal through the production gateway", async () => {
    await sync(recipient);
    const privateBefore = solBalance(recipient);
    const publicBefore = await client.getBalance(recipient.owner.address);
    const devnet = requireConfig();
    const operationWalletId = walletId(recipient.owner.index);
    const now = new Date().toISOString();
    const operation: PrivateOperation = {
      id: "devnet-e2e:production-gateway-withdraw",
      walletId: operationWalletId,
      opType: "withdraw",
      state: "proving",
      approvalRequestId: null,
      policyEvaluationId: null,
      proof: null,
      outerTxSignature: null,
      photonIndexedAt: null,
      failure: null,
      input: {
        walletId: operationWalletId,
        opType: "withdraw",
        asset: { mint: SDP_NATIVE_MINT, amountRaw: WITHDRAW_LAMPORTS.toString() },
        to: recipient.owner.address,
        clientNonce: "production-gateway-withdraw",
      },
      intentKey: "devnet-e2e:production-gateway-withdraw",
      events: [],
      createdAt: now,
      updatedAt: now,
    };

    const built = await createRingsGateway({
      solanaRpcUrl: devnet.rpcUrl,
      indexerUrl: devnet.indexerUrl,
      proverUrl: devnet.proverUrl,
      derivationSeed: Buffer.from(devnet.seed).toString("base64"),
      allowInsecureHttp: devnet.allowInsecureHttp,
      ...DERIVATION_SCOPE,
    }).buildOperation({
      operation,
      owner: recipient.owner.address,
      expectedShieldedAddress: canonicalShieldedIdentity(recipient.material.shieldedAddress),
    });
    const transaction = getTransactionDecoder().decode(
      getBase64Codec().encode(built.outerUnsignedTxBase64)
    );
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);

    if (message.version !== 0) {
      throw new Error("Expected the production gateway to build a v0 Rings transaction.");
    }

    const [computeInstruction, protocolInstruction] = message.instructions;
    if (!computeInstruction || !protocolInstruction) {
      throw new Error("Expected compute-budget and Rings protocol instructions.");
    }

    const expectedComputeInstruction = getSetComputeUnitLimitInstruction({
      units: MAX_COMPUTE_UNIT_LIMIT,
    });
    expect(message.instructions).toHaveLength(2);
    expect(message.staticAccounts[computeInstruction.programAddressIndex]).toBe(
      expectedComputeInstruction.programAddress
    );
    expect(computeInstruction.data).toEqual(expectedComputeInstruction.data);
    expect(message.staticAccounts[protocolInstruction.programAddressIndex]).not.toBe(
      expectedComputeInstruction.programAddress
    );
    expect(message.staticAccounts[0]).toBe(recipient.owner.address);
    expect(Object.keys(transaction.signatures)).toEqual([recipient.owner.address]);
    expect(built.requiredSigners).toEqual([recipient.owner.address]);
    expect(built.inputNotes.length).toBeGreaterThan(0);
    expect(built.proof.source).toBe("live");
    expect(JSON.stringify(built.proof.ref)).toBe('"[REDACTED]"');

    log.record(
      "withdraw/sol-production-gateway",
      await submitAndConfirm(client, transaction, [recipient.owner.keyPair])
    );

    await sync(recipient);
    expect(solBalance(recipient)).toBe(privateBefore - WITHDRAW_LAMPORTS);
    // Fees come out of the same account, so the public side only has to grow by
    // less than the withdrawal rather than by exactly it.
    expect(await client.getBalance(recipient.owner.address)).toBeGreaterThan(publicBefore);
  });

  it("reconstructs transfer and withdrawal history in a fresh wallet", async () => {
    await sync(recipient);
    const restored = await buildIdentity(recipient.owner.index);

    try {
      await sync(restored);

      expect(solBalance(restored)).toBe(solBalance(recipient));
      expect(getPrivateTransactions(restored.wallet).map((entry) => entry.kind)).toEqual(
        expect.arrayContaining(["privateTransfer", "publicWithdrawal"])
      );
    } finally {
      restored.material.destroy();
    }
  });

  // Zolana 0.1.1-alpha reconstructs ciphertext-free merge outputs from input
  // UTXOs retained on the in-memory Wallet. A fresh API Wallet cannot replay
  // that output after restart, so the product flow stays disabled until wallet
  // snapshots are persisted or upstream full-history replay is fixed.
  it.skip("merges notes without changing total value", async () => {
    await shield(sender, SHIELD_LAMPORTS, "shield/sol-merge-input");
    await sync(sender);

    const notesBefore = unspentSolNotes(sender);
    const valueBefore = solBalance(sender);
    expect(notesBefore).toBeGreaterThan(1);

    log.record(
      "merge/sol",
      await submitAndConfirm(
        client,
        await buildMergeTransaction({
          client,
          wallet: sender.wallet,
          authority: authorityFor(sender, "merge"),
          feePayer: sender.owner.address,
          asset: SOL,
        }),
        [sender.owner.keyPair]
      )
    );

    await sync(sender);
    expect(unspentSolNotes(sender)).toBeLessThan(notesBefore);
    expect(solBalance(sender)).toBe(valueBefore);
  });

  it.skipIf(config?.splMint === undefined)(
    "shields, transfers and withdraws a classic SPL asset",
    async () => {
      const { splMint } = requireConfig();
      if (splMint === undefined) {
        throw new Error("The SPL leg requires HELIUS_RINGS_E2E_SPL_MINT.");
      }

      const mint = address(splMint);
      await sync(sender);
      const before = sender.wallet.balance(mint).amount;

      log.record(
        "shield/spl",
        await submitAndConfirm(
          client,
          await buildDepositTransaction({
            client,
            feePayer: sender.owner.address,
            recipient: sender.material.shieldedAddress,
            asset: mint,
            amount: 1_000n,
          }),
          [sender.owner.keyPair]
        )
      );

      await sync(sender);
      expect(sender.wallet.balance(mint).amount).toBe(before + 1_000n);

      log.record(
        "transfer/spl",
        await submitAndConfirm(
          client,
          await buildTransferTransaction({
            client,
            wallet: sender.wallet,
            authority: authorityFor(sender, "transfer_registered_spl"),
            feePayer: sender.owner.address,
            recipient: recipient.owner.address,
            asset: mint,
            amount: 400n,
          }),
          [sender.owner.keyPair]
        )
      );

      log.record(
        "withdraw/spl",
        await submitAndConfirm(
          client,
          await buildWithdrawalTransaction({
            client,
            wallet: sender.wallet,
            authority: authorityFor(sender, "withdraw_spl"),
            feePayer: sender.owner.address,
            recipient: sender.owner.address,
            asset: mint,
            amount: 200n,
          }),
          [sender.owner.keyPair]
        )
      );

      await sync(sender);
      expect(sender.wallet.balance(mint).amount).toBe(before + 400n);
    }
  );
});
