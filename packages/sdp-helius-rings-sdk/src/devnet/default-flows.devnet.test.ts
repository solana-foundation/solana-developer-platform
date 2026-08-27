import { SOL_MINT, Wallet } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import {
  backfillAssetRegistry,
  buildDepositTransaction,
  buildMergeTransaction,
  buildRegistrationTransaction,
  buildTransferTransaction,
  buildWithdrawalTransaction,
  fetchUserRecord,
  getPrivateTransactions,
  syncWallet,
} from "@heliuslabs/zolana/wallet";
import type { PrivateOperation } from "@sdp/helius-rings";
import { address, getBase64Codec, getTransactionDecoder } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CustodyWalletAuthority } from "../authority.js";
import { createRingsClient } from "../client.js";
import { deriveMaterial } from "../deterministic-ka/index.js";
import { SDP_NATIVE_MINT } from "../flows/mint.js";
import { createRingsGateway, type RingsGatewayConfig } from "../gateway.js";
import { canonicalShieldedIdentity, type ShieldedMaterial } from "../material.js";
import { type OuterTransactionPolicyIntent, validateOuterTransaction } from "../outer-tx-policy.js";
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
 * The production-gateway SOL flow gate.
 *
 * It proves that an identity whose viewing and nullifier keys were derived
 * outside the custodian can register and run every product-enabled SOL flow
 * through the same gateway and final-wire policy used by SDP.
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
// Owner 0 has historical merge output from the pre-disable gate. A fresh
// Wallet cannot replay that output, so it is permanently retired from this
// restart-safety scenario rather than teaching the gate to ignore degradation.
const SENDER_OWNER_INDEX = 1;
const RECIPIENT_OWNER_INDEX = 2;

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

type SolOperationSpec =
  | Readonly<{
      opType: "shield";
      amount: bigint;
      clientNonce: string;
    }>
  | Readonly<{
      opType: "transfer_registered" | "withdraw";
      amount: bigint;
      to: string;
      clientNonce: string;
    }>;

let client: ZolanaClient;
let gateway: ReturnType<typeof createRingsGateway>;
let sender: Identity;
let recipient: Identity;
const log = new FlowLog();

function devnetGatewayConfig(): RingsGatewayConfig {
  const devnet = requireConfig();
  return {
    solanaRpcUrl: devnet.rpcUrl,
    indexerUrl: devnet.indexerUrl,
    proverUrl: devnet.proverUrl,
    derivationSeed: Buffer.from(devnet.seed).toString("base64"),
    allowInsecureHttp: devnet.allowInsecureHttp,
    ...DERIVATION_SCOPE,
  };
}

function persistedOperation(identity: Identity, spec: SolOperationSpec): PrivateOperation {
  const operationWalletId = walletId(identity.owner.index);
  const now = new Date().toISOString();
  const id = `devnet-e2e:${identity.owner.index}:${spec.clientNonce}`;

  return {
    id,
    walletId: operationWalletId,
    opType: spec.opType,
    state: "proving",
    approvalRequestId: null,
    policyEvaluationId: null,
    proof: null,
    outerTxSignature: null,
    photonIndexedAt: null,
    failure: null,
    input: {
      walletId: operationWalletId,
      opType: spec.opType,
      asset: { mint: SDP_NATIVE_MINT, amountRaw: spec.amount.toString() },
      ...("to" in spec ? { to: spec.to } : {}),
      clientNonce: spec.clientNonce,
    },
    intentKey: id,
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}

function outerPolicyIntent(
  identity: Identity,
  spec: SolOperationSpec
): OuterTransactionPolicyIntent {
  const common = { mint: SDP_NATIVE_MINT, amountRaw: spec.amount.toString() };

  switch (spec.opType) {
    case "shield":
      return {
        opType: "shield",
        ...common,
        expectedShieldedAddress: canonicalShieldedIdentity(identity.material.shieldedAddress),
      };
    case "transfer_registered":
      return { opType: "transfer_registered", ...common };
    case "withdraw":
      return { opType: "withdraw", ...common, to: spec.to };
  }
}

async function buildGatewaySolTransaction(identity: Identity, spec: SolOperationSpec) {
  const expectedShieldedAddress = canonicalShieldedIdentity(identity.material.shieldedAddress);
  const built = await gateway.buildOperation({
    operation: persistedOperation(identity, spec),
    owner: identity.owner.address,
    expectedShieldedAddress,
  });

  // This decodes the gateway-returned wire and binds its signer, accounts,
  // instructions and public settlement to the persisted operation before the
  // harness is allowed to sign it.
  await validateOuterTransaction({
    outerUnsignedTxBase64: built.outerUnsignedTxBase64,
    owner: identity.owner.address,
    intent: outerPolicyIntent(identity, spec),
  });

  const transaction = getTransactionDecoder().decode(
    getBase64Codec().encode(built.outerUnsignedTxBase64)
  );
  expect(built.proof.source).toBe("live");
  expect(JSON.stringify(built.proof.ref)).toBe('"[REDACTED]"');
  expect(built.requiredSigners).toEqual([identity.owner.address]);
  expect(Object.keys(transaction.signatures)).toEqual([identity.owner.address]);

  if (spec.opType === "shield") {
    expect(built.inputNotes).toEqual([]);
  } else {
    expect(built.inputNotes.length).toBeGreaterThan(0);
  }

  return transaction;
}

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
 * Refreshes one retained Wallet from the indexer. Only the explicit replay test
 * below constructs a fresh Wallet and therefore exercises restart behavior.
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

function expectCurrentRunHistoryRow(
  wallet: Wallet,
  expected: Readonly<{
    signature: string;
    kind: "privateTransfer" | "publicWithdrawal";
    amount: bigint;
    direction: "inbound" | "outbound";
  }>
): void {
  const matching = getPrivateTransactions(wallet)
    .filter((entry) => entry.id.signature === expected.signature)
    .map((entry) => ({
      signature: entry.id.signature,
      kind: entry.kind,
      amount: entry.amount,
      direction: entry.direction,
      asset: entry.asset,
    }));

  expect(matching).toEqual([{ ...expected, asset: SOL }]);
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

function assertRegisteredIdentity(
  record: Awaited<ReturnType<typeof fetchUserRecord>>,
  identity: Identity
): void {
  if (record === undefined) {
    throw new Error(`Rings registration for owner ${identity.owner.index} was not found.`);
  }

  expect(record.owner).toBe(identity.owner.address);
  expect(record.nullifierPublicKey).toStrictEqual(identity.material.nullifierKey.publicKey());
  expect(record.viewingPublicKey).toStrictEqual(identity.material.viewingKey.publicKey().toBytes());
}

/** Registration is idempotent: an existing record with our keys is a no-op. */
async function ensureRegistered(identity: Identity): Promise<void> {
  const existing = await fetchUserRecord({ rpc: client, owner: identity.owner.address });

  if (existing === undefined) {
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

  assertRegisteredIdentity(
    await fetchUserRecord({ rpc: client, owner: identity.owner.address }),
    identity
  );
}

async function shield(identity: Identity, amount: bigint, label: string): Promise<void> {
  log.record(
    label,
    await submitAndConfirm(
      client,
      await buildGatewaySolTransaction(identity, {
        opType: "shield",
        amount,
        clientNonce: label,
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
  gateway = createRingsGateway(devnetGatewayConfig());

  await assertDevnet(client);

  sender = await buildIdentity(SENDER_OWNER_INDEX);
  recipient = await buildIdentity(RECIPIENT_OWNER_INDEX);

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

  it("runs registration through fresh replay as one fail-fast SOL scenario", async () => {
    // Registration is part of the same test as every fund-moving prerequisite.
    // Filtering this test therefore cannot start midway through the sequence,
    // and any failed assertion prevents all later transactions from running.
    await ensureRegistered(sender);
    await ensureRegistered(recipient);

    await sync(sender);
    const shieldBefore = solBalance(sender);

    await shield(sender, SHIELD_LAMPORTS, "shield/sol");

    await sync(sender);
    expect(solBalance(sender)).toBe(shieldBefore + SHIELD_LAMPORTS);

    await sync(sender);
    await sync(recipient);
    const senderBefore = solBalance(sender);
    const recipientBefore = solBalance(recipient);

    const transferTransaction = await buildGatewaySolTransaction(sender, {
      opType: "transfer_registered",
      amount: TRANSFER_LAMPORTS,
      to: recipient.owner.address,
      clientNonce: "transfer-registered",
    });

    const transferSubmission = log.record(
      "transfer/registered",
      await submitAndConfirm(client, transferTransaction, [sender.owner.keyPair])
    );

    await sync(sender);
    await sync(recipient);
    expect(solBalance(sender)).toBe(senderBefore - TRANSFER_LAMPORTS);
    expect(solBalance(recipient)).toBe(recipientBefore + TRANSFER_LAMPORTS);

    await sync(recipient);
    const privateBefore = solBalance(recipient);
    const publicBefore = await client.getBalance(recipient.owner.address);
    const withdrawalTransaction = await buildGatewaySolTransaction(recipient, {
      opType: "withdraw",
      amount: WITHDRAW_LAMPORTS,
      to: recipient.owner.address,
      clientNonce: "production-gateway-withdraw",
    });

    const withdrawalSubmission = log.record(
      "withdraw/sol-production-gateway",
      await submitAndConfirm(client, withdrawalTransaction, [recipient.owner.keyPair])
    );

    await sync(recipient);
    expect(solBalance(recipient)).toBe(privateBefore - WITHDRAW_LAMPORTS);
    // The recipient also pays the transaction fee, so its net public gain is
    // positive but strictly less than the private value withdrawn.
    const publicAfter = await client.getBalance(recipient.owner.address);
    expect(publicAfter).toBeGreaterThan(publicBefore);
    expect(publicAfter - publicBefore).toBeLessThan(WITHDRAW_LAMPORTS);

    const restored = await buildIdentity(recipient.owner.index);

    try {
      await sync(restored);

      expect(solBalance(restored)).toBe(solBalance(recipient));
      expectCurrentRunHistoryRow(restored.wallet, {
        signature: transferSubmission.signature,
        kind: "privateTransfer",
        amount: TRANSFER_LAMPORTS,
        direction: "inbound",
      });
      expectCurrentRunHistoryRow(restored.wallet, {
        signature: withdrawalSubmission.signature,
        kind: "publicWithdrawal",
        amount: WITHDRAW_LAMPORTS,
        direction: "outbound",
      });
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

  // The production gateway deliberately refuses SPL withdrawal because the
  // upstream public surface cannot derive its token-interface address while
  // preserving pinned inputs. Keep this optional upstream-builder leg honest.
  it.skipIf(config?.splMint === undefined)(
    "exercises the optional classic SPL leg through direct upstream builders",
    async () => {
      const { splMint } = requireConfig();
      if (splMint === undefined) {
        throw new Error("The SPL leg requires HELIUS_RINGS_E2E_SPL_MINT.");
      }

      const mint = address(splMint);
      await ensureRegistered(sender);
      await ensureRegistered(recipient);
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
