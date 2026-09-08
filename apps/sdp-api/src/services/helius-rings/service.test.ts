import type { BuildOperationInput } from "@sdp/helius-rings";
import { HeliusRingsError, type PrivateOperationInput } from "@sdp/helius-rings";
import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import type { PolicyDecision } from "@sdp/types";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createKeyPairFromPrivateKeyBytes,
  createTransactionMessage,
  getAddressEncoder,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase64Codec,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  type SignatureBytes,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  createHeliusRingsProjectRingRepository,
  createHeliusRingsWalletRepository,
} from "@/db/repositories";
import type { HeliusRingsOperationRepository } from "@/db/repositories/helius-rings-operation.repository";
import { createPostgresHeliusRingsOperationRepository } from "@/db/repositories/helius-rings-operation.repository.postgres";
import { AppError } from "@/lib/errors";
import { HeliusRingsConnectionStore } from "@/services/stores/helius-rings-connection.store";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import { InMemoryRingsGateway } from "@/test/fixtures/in-memory-rings-gateway";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { gatewayStub } from "@/test/fixtures/rings-gateway";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { RingsAdapterError } from "./adapter-error";
import { type RingsOuterTransactionPolicyInput, UnconfiguredRingsGateway } from "./gateway";
import {
  computeIntentKey,
  createHeliusRingsService,
  type HeliusRingsServiceDependencies,
} from "./service";

const TEST_PROJECT_ID = "prj_hrs_service_test";
const TEST_CONNECTION_ID = "hrconn_hrs_service_test";
const tenant = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };

let walletId: string;

const WALLET_KEYPAIR = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(51));
const WALLET_OWNER = await getAddressFromPublicKey(WALLET_KEYPAIR.publicKey);
const SHIELDED_OWNER_HASH = new Uint8Array(32).fill(3);
const WALLET_SHIELDED_IDENTITY = getBase58Decoder().decode(
  Uint8Array.from([...SHIELDED_OWNER_HASH, ...new Uint8Array(33).fill(5)])
);

function policyStub(
  decision: PolicyDecision,
  overrides: { requiresApproval?: boolean; approvalRequestId?: string | null } = {}
): HeliusRingsServiceDependencies["enforcePolicy"] {
  return async () =>
    ({
      operation: { id: "wop_1" },
      evaluation: {
        id: "pev_1",
        decision,
        reason: decision === "deny" ? "denied by wallet policy" : null,
        requiresApproval: overrides.requiresApproval ?? false,
        approvalRequestId: overrides.approvalRequestId ?? null,
      },
    }) as unknown as WalletOperationPolicyEnforcement;
}

function operationInput(overrides: Partial<PrivateOperationInput> = {}): PrivateOperationInput {
  const opType = overrides.opType ?? "shield";
  return {
    walletId,
    opType,
    asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1000000" },
    ...(opType === "withdraw" || opType === "transfer_registered" ? { to: WALLET_OWNER } : {}),
    clientNonce: "nonce-1",
    ...overrides,
  };
}

const actorContext = { apiKeyId: "key_1", actor: null, custodyWalletId: "cw_1" };

/** Fails an operation that has already signed, leaving its bytes in place. */
async function failSigned(id: string, state: string): Promise<void> {
  await createPostgresHeliusRingsOperationRepository(getDb(env)).failOperation({
    ...tenant,
    id,
    expectedState: state as "indexing",
    code: "indexing_timeout",
    message: "photon never caught up",
    retryable: true,
  });
}

function service(deps: HeliusRingsServiceDependencies = {}) {
  return createHeliusRingsService(env, tenant, {
    enforcePolicy: policyStub("allow"),
    gateway: new UnconfiguredRingsGateway(),
    resolveConnectionId: async () => TEST_CONNECTION_ID,
    ...deps,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function u64(value: bigint): number[] {
  return Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(index * 8)) & 255n));
}

/**
 * A Kit-6 encoding of the one shield shape the Kit-7 SDK policy accepts.
 * Keeping the fixture on this side of the boundary proves the validator
 * consumes wire bytes rather than relying on cross-major brands.
 */
function unsignedShieldTransaction(
  amount: bigint,
  blockhash: Blockhash = "5DjPMLBWWLbNw3TRUEbCwPFvpXqhkdVv2VUb3RJhZmpJ" as Blockhash
): string {
  const owner = address(WALLET_OWNER);
  const pool = address("sppXZU59VoYodv9Accs4hHNTjYiuYmDFyFVjUjPxFsG");
  const tree = address("trEEbaNobcTESNmtsPBj3FX27q5sDCQePV2kb12FYho");
  const system = address("11111111111111111111111111111111");
  const solInterface = getBase58Decoder().decode(
    Uint8Array.from([
      226, 231, 179, 96, 7, 216, 134, 74, 16, 116, 193, 73, 186, 110, 210, 48, 2, 97, 154, 130, 121,
      53, 28, 232, 140, 221, 183, 236, 109, 212, 72, 117,
    ])
  ) as Address;
  const deposit: Instruction = {
    programAddress: pool,
    accounts: [
      { address: tree, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.WRITABLE_SIGNER },
      { address: pool, role: AccountRole.READONLY },
      { address: system, role: AccountRole.READONLY },
      { address: solInterface, role: AccountRole.WRITABLE },
    ],
    data: Uint8Array.from([
      11,
      1,
      0,
      1,
      0,
      ...getAddressEncoder().encode(owner),
      ...SHIELDED_OWNER_HASH,
      ...new Uint8Array(32).fill(7),
      ...u64(amount),
      0,
      0,
    ]),
  };
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(owner, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash,
            lastValidBlockHeight: 100n,
          },
          message
        ),
      (message) => appendTransactionMessageInstructions([deposit], message)
    )
  );
  return getBase64Codec().decode(getTransactionEncoder().encode(transaction));
}

async function signWalletTransaction(unsignedTxBase64: string): Promise<{
  signedTxBase64: string;
  signature: string;
}> {
  const transaction = getTransactionDecoder().decode(getBase64Codec().encode(unsignedTxBase64));
  const ownerSignature = await signBytes(WALLET_KEYPAIR.privateKey, transaction.messageBytes);
  const signed = {
    ...transaction,
    signatures: { [WALLET_OWNER]: ownerSignature as SignatureBytes },
  };
  return {
    signedTxBase64: getBase64Codec().decode(getTransactionEncoder().encode(signed)),
    signature: getSignatureFromTransaction(signed),
  };
}

const OUTER_TX = await signWalletTransaction(unsignedShieldTransaction(1_000_000n));
const CHANGED_OUTER_TX = await signWalletTransaction(
  unsignedShieldTransaction(
    1_000_000n,
    getBase58Decoder().decode(new Uint8Array(32).fill(52)) as Blockhash
  )
);

/**
 * A service whose gateway succeeds and whose sign/submit adapters are stubbed.
 * The signer returns real wire bytes because the service derives the outer
 * signature from them before it broadcasts.
 */
function liveishService(deps: HeliusRingsServiceDependencies = {}) {
  return service({
    gateway: new InMemoryRingsGateway({
      buildUnsignedTx: () => unsignedShieldTransaction(1_000_000n),
    }),
    validateOuterTransaction: async () => undefined,
    signOuterTransaction: async ({ unsignedTxBase64 }) =>
      (await signWalletTransaction(unsignedTxBase64)).signedTxBase64,
    submitOuterTransaction: async ({ signedTxBase64 }) =>
      getSignatureFromTransaction(
        getTransactionDecoder().decode(getBase64Codec().encode(signedTxBase64))
      ),
    ...deps,
  });
}

function retryableFailureService() {
  const gateway = new InMemoryRingsGateway();
  gateway.buildOperation = () =>
    Promise.reject(new HeliusRingsError("gateway_unavailable", "port unavailable"));
  return service({ gateway });
}

describe("HeliusRingsService", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();

    const credentialId = "pcred_hrs_service_test";
    const credential = await new ProviderCredentialStore(db).insertCredential({
      id: credentialId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      provider: "helius_rings",
      label: "Service test",
      scope: "project",
      source: "stored",
      stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "test-only" },
      displayMetadata: {},
      version: 1,
      rotatedFromId: null,
      idempotencyKey: TEST_CONNECTION_ID,
      idempotencyFingerprint: TEST_CONNECTION_ID,
      createdBy: TEST_USER.id,
    });
    await db.execute("UPDATE provider_credentials SET status = 'active' WHERE id = ?", [
      credentialId,
    ]);
    await new HeliusRingsConnectionStore(db).insert({
      id: TEST_CONNECTION_ID,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      name: "Service test",
      providerCredentialId: credentialId,
      providerCredentialScopeKey: credential.scope_key,
      allowInsecureHttp: false,
      displayMetadata: {},
      makeDefault: true,
      createdBy: TEST_USER.id,
    });

    const wallets = createHeliusRingsWalletRepository(env);
    const wallet = await wallets.createWallet({
      ...tenant,
      sdpWalletId: "wal_hrs_service_test",
      name: "Treasury",
      materialTag: "simulated",
    });
    if (!wallet) throw new Error("wallet fixture was not created");
    walletId = wallet.id;

    // Provisioned, because every operation test below spends from it and the
    // pipeline needs the owner the identity is published under. A wallet with
    // no identity has nothing to spend.
    await wallets.markProvisioned({
      ...tenant,
      id: wallet.id,
      shieldedAddress: WALLET_SHIELDED_IDENTITY,
      ownerAddress: WALLET_OWNER,
      materialTag: "simulated",
      expectedStatus: "pending",
    });
  });

  describe("devnet guard", () => {
    it("refuses to construct outside devnet", () => {
      expect(() =>
        createHeliusRingsService({ ...env, SOLANA_NETWORK: "mainnet-beta" }, tenant)
      ).toThrow(AppError);
    });
  });

  describe("provisionPrivateWallet", () => {
    it("provisions through the gateway and marks the wallet ready", async () => {
      const wallet = await service({ gateway: new InMemoryRingsGateway() }).provisionPrivateWallet({
        sdpWalletId: "wal_prov_1",
        sdpAddress: "addr1",
        name: "Ops",
      });

      expect(wallet.status).toBe("ready");
      expect(wallet.shieldedAddress).toMatch(/^rings1/);
    });

    it("leaves the wallet pending when the gateway is not implemented", async () => {
      const result = await service()
        .provisionPrivateWallet({ sdpWalletId: "wal_prov_2", sdpAddress: "addr2", name: "Ops" })
        .then(
          () => null,
          (error: unknown) => error
        );

      expect(result).toMatchObject({ code: "config_error" });
      const rows = await createHeliusRingsWalletRepository(env).getWalletBySdpWalletId({
        ...tenant,
        sdpWalletId: "wal_prov_2",
      });
      expect(rows?.status).toBe("pending");
    });

    it("records the custody wallet row the identity will sign through", async () => {
      const db = getDb(env);
      await db
        .prepare(
          `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted)
           VALUES ('cc_prov_3', ?, ?, 'turnkey', '{}')`
        )
        .bind(TEST_ORG.id, TEST_PROJECT_ID)
        .run();
      await db
        .prepare(
          `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key)
           VALUES ('cw_prov_3', 'cc_prov_3', 'wal_prov_3', 'addr3')`
        )
        .run();

      await service({ gateway: new InMemoryRingsGateway() }).provisionPrivateWallet({
        sdpWalletId: "wal_prov_3",
        sdpAddress: "addr3",
        name: "Ops",
        custodyWalletId: "cw_prov_3",
      });

      const row = await createHeliusRingsWalletRepository(env).getWalletBySdpWalletId({
        ...tenant,
        sdpWalletId: "wal_prov_3",
      });
      // The provider's own id can be reissued; this one cannot, and it is what
      // resolves the key that signs.
      expect(row?.custody_wallet_id).toBe("cw_prov_3");
      expect(row?.owner_address).toBe("addr3");
    });
  });

  describe("syncWallet", () => {
    it("reads balances and records when the observation was made", async () => {
      const result = await service({ gateway: new InMemoryRingsGateway() }).syncWallet(walletId);

      expect(result.observedAt).toEqual(expect.any(String));

      const row = await createHeliusRingsWalletRepository(env).getWalletById({
        ...tenant,
        id: walletId,
      });
      // Written for the dashboard to display, never read back as a resume
      // position — the SDK keeps three independent read streams.
      expect(row?.sync_cursor).toBe(result.observedAt);
    });

    it("tells the gateway which identity it expects, and what the mints are", async () => {
      const gateway = new InMemoryRingsGateway();
      const syncPhoton = vi.spyOn(gateway, "syncPhoton");

      await service({ gateway }).syncWallet(walletId);

      expect(syncPhoton).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId,
          owner: WALLET_OWNER,
          expectedShieldedAddress: WALLET_SHIELDED_IDENTITY,
        })
      );
      // Seeded by 0057; without them a real balance renders at the wrong
      // magnitude or with no symbol at all.
      const [{ knownAssets }] = syncPhoton.mock.calls[0] as [{ knownAssets: { symbol: string }[] }];
      expect(knownAssets.map((asset) => asset.symbol).sort()).toEqual(["SOL", "USDC"]);
    });

    it("makes the next read wait for the indexer to reach the last thing it saw", async () => {
      const gateway = new InMemoryRingsGateway();
      const syncPhoton = vi.spyOn(gateway, "syncPhoton");

      // First sync: nothing has touched the wallet, so there is no position to
      // wait for and asking for one would block on a slot nothing produced.
      await service({ gateway }).syncWallet(walletId);
      expect(syncPhoton.mock.calls[0]?.[0]).not.toHaveProperty("requireSlot");

      const observed = (await createHeliusRingsWalletRepository(env).getWalletById({
        ...tenant,
        id: walletId,
      })) as { last_indexed_slot: string | null };
      expect(observed.last_indexed_slot).not.toBeNull();

      // Second sync gates on it. Photon trails the chain, so without this the
      // read could describe a moment before the first sync's history existed.
      await service({ gateway }).syncWallet(walletId);
      expect(syncPhoton.mock.calls[1]?.[0]).toMatchObject({
        requireSlot: observed.last_indexed_slot,
      });
    });

    it("never moves the read position backwards", async () => {
      const wallets = createHeliusRingsWalletRepository(env);

      await wallets.advanceIndexedSlot({ ...tenant, id: walletId, slot: "5000" });
      // Two sources advance this — a completed operation and a sync — and they
      // can report out of order. Taking the lower would let a later read gate
      // on a position the wallet has already passed.
      await wallets.advanceIndexedSlot({ ...tenant, id: walletId, slot: "100" });

      const row = await wallets.getWalletById({ ...tenant, id: walletId });
      expect(row?.last_indexed_slot).toBe("5000");
    });

    it("does not move the read position from a degraded sync", async () => {
      const gateway = new InMemoryRingsGateway();
      // A sync that could not read everything still returns balances, and
      // `observedSlot` is the highest slot it managed to parse — not evidence
      // that everything up to it was seen.
      vi.spyOn(gateway, "syncPhoton").mockResolvedValue({
        balances: [],
        history: [],
        report: {
          storedNotes: 0,
          unparsedTransactions: 3,
          undecryptableCandidates: 0,
          unknownAssetIds: 0,
          unknownAssetFields: 0,
          degraded: true,
        },
        indexedOperationSignatures: [],
        observedAt: new Date().toISOString(),
        observedSlot: "9999",
      });

      await service({ gateway }).syncWallet(walletId);

      const row = await createHeliusRingsWalletRepository(env).getWalletById({
        ...tenant,
        id: walletId,
      });
      // Advancing here would make the next read gate on a position this wallet
      // has not been read through, and report the result as fresh.
      expect(row?.last_indexed_slot).toBeNull();
    });

    it("refuses a wallet that has never been provisioned", async () => {
      const wallet = await createHeliusRingsWalletRepository(env).createWallet({
        ...tenant,
        sdpWalletId: "wal_unprovisioned",
        name: "Fresh",
        materialTag: "simulated",
      });
      if (!wallet) throw new Error("wallet fixture was not created");

      // There is no identity to read balances for, and reporting an empty
      // wallet would be indistinguishable from a provisioned one holding
      // nothing.
      await expect(
        service({ gateway: new InMemoryRingsGateway() }).syncWallet(wallet.id)
      ).rejects.toMatchObject({ code: "conflict" });
    });
  });

  describe("prepareOperation", () => {
    it("is idempotent: the same client nonce returns the same operation", async () => {
      const svc = service();
      const first = await svc.prepareOperation(operationInput(), actorContext);
      const replay = await svc.prepareOperation(operationInput(), actorContext);

      expect(replay.id).toBe(first.id);
      expect(replay.intentKey).toBe(computeIntentKey(operationInput(), null));
    });

    it("fails a private transfer when the recipient shielded address is not a wallet in this project", async () => {
      // WALLET_OWNER is a Solana pubkey, not a shielded address, so the recipient
      // lookup by shielded_address returns no row and the pipeline records an
      // invalid_input failure before any bytes are built.
      const operation = await liveishService().prepareOperation(
        operationInput({
          clientNonce: "nonce-transfer-unknown-recipient",
          opType: "transfer_registered",
        }),
        actorContext
      );

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "invalid_input" });
      expect(operation.failure?.message).toMatch(/private transfer recipient/);
    });

    it("ends in failed:policy_denied when the policy denies", async () => {
      const operation = await service({ enforcePolicy: policyStub("deny") }).prepareOperation(
        operationInput({ clientNonce: "nonce-deny" }),
        actorContext
      );

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "policy_denied", retryable: false });
    });

    it("pauses at approval_required and records the approval request", async () => {
      const operation = await service({
        enforcePolicy: policyStub("approval_required", {
          requiresApproval: true,
          approvalRequestId: "apr_1",
        }),
      }).prepareOperation(operationInput({ clientNonce: "nonce-approval" }), actorContext);

      expect(operation.state).toBe("approval_required");
      expect(operation.approvalRequestId).toBe("apr_1");
      expect(operation.policyEvaluationId).toBe("pev_1");
    });

    it("fails honestly at the port when the gateway is not implemented", async () => {
      const operation = await service().prepareOperation(
        operationInput({ clientNonce: "nonce-notimpl" }),
        actorContext
      );

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "config_error", retryable: false });
    });

    it("does not offer a retry when the gateway is merely misconfigured", async () => {
      const gateway = new InMemoryRingsGateway();
      gateway.buildOperation = () =>
        Promise.reject(new HeliusRingsError("config_error", "Helius Rings setup is required"));

      const operation = await service({ gateway }).prepareOperation(
        operationInput({ clientNonce: "nonce-misconfigured" }),
        actorContext
      );

      // No amount of retrying supplies an environment variable, so the retry
      // affordance would send the operator back to the wrong lever. The code
      // says so too, rather than hiding behind the transient-sounding
      // `gateway_unavailable` it had to borrow before 0067 added this one.
      expect(operation.failure).toMatchObject({ code: "config_error", retryable: false });
      expect(operation.failure?.message).toContain("Helius Rings setup is required");
    });

    it("resends the persisted bytes when resumed in submitted", async () => {
      const sent: string[] = [];
      const svc = () =>
        liveishService({
          gateway: new InMemoryRingsGateway({
            indexingDelayMs: 60 * 60 * 1000,
            buildUnsignedTx: () => unsignedShieldTransaction(1_000_000n),
          }),
          submitOuterTransaction: async ({ signedTxBase64 }) => {
            sent.push(signedTxBase64);
            return OUTER_TX.signature;
          },
        });

      const operation = await svc().prepareOperation(
        operationInput({ clientNonce: "nonce-resubmit" }),
        actorContext
      );

      // Exactly what a process that died between the RPC call and the
      // submitted → indexing commit leaves behind.
      await getDb(env)
        .prepare("UPDATE helius_rings_operations SET state = 'submitted' WHERE id = ?")
        .bind(operation.id)
        .run();

      await svc().executeOperation(operation.id);

      // The same bytes, not a rebuild. A duplicate of a landed transaction is
      // rejected by the chain; a rebuild could select other notes and settle
      // twice.
      const expected = (await signWalletTransaction(unsignedShieldTransaction(1_000_000n)))
        .signedTxBase64;
      expect(sent).toEqual([expected, expected]);
    });

    it("never offers a retry when the gateway says the notes are gone", async () => {
      const gateway = new InMemoryRingsGateway();
      gateway.buildOperation = () =>
        Promise.reject(
          new HeliusRingsError(
            "manual_reconciliation_required",
            "2 of 2 pinned notes are no longer spendable"
          )
        );

      const operation = await service({ gateway }).prepareOperation(
        operationInput({ clientNonce: "nonce-mrr" }),
        actorContext
      );

      // The notes are gone most likely because the attempt this was recovering
      // already settled. Offering a retry here is the double payment the
      // pinning exists to prevent, so the code must survive the mapping.
      expect(operation.failure).toMatchObject({
        code: "manual_reconciliation_required",
        retryable: false,
      });
    });

    it("refuses a fresh spend while an earlier signed one is unaccounted for", async () => {
      const operation = await liveishService().prepareOperation(
        operationInput({ clientNonce: "nonce-unresolved-1", opType: "withdraw" }),
        actorContext
      );
      // The precondition the whole test rests on: it got far enough to sign.
      expect(operation.state).toBe("indexing");

      // It reached submission, so bytes exist; then it failed the way a slow
      // Photon makes it fail.
      await failSigned(operation.id, operation.state);

      // The retry endpoint refuses, so the obvious next move is to file it
      // again under a new nonce — the door the guard did not cover. That
      // transaction may already have settled, so a second one pays twice.
      await expect(
        liveishService().prepareOperation(
          operationInput({ clientNonce: "nonce-unresolved-2", opType: "withdraw" }),
          actorContext
        )
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("still allows a shield while a spend is unresolved", async () => {
      const operation = await liveishService().prepareOperation(
        operationInput({ clientNonce: "nonce-shield-ok-1", opType: "withdraw" }),
        actorContext
      );
      await failSigned(operation.id, operation.state);

      // A deposit that lands late only adds notes, so it cannot duplicate the
      // stuck payment. Blocking it would freeze the wallet further than the
      // hazard justifies.
      await expect(
        liveishService().prepareOperation(
          operationInput({ clientNonce: "nonce-shield-ok-2", opType: "shield" }),
          actorContext
        )
      ).resolves.toBeDefined();
    });

    it("refuses a second shield while an earlier signed one is unaccounted for", async () => {
      const operation = await liveishService().prepareOperation(
        operationInput({ clientNonce: "nonce-shield-dup-1", opType: "shield" }),
        actorContext
      );
      expect(operation.state).toBe("indexing");
      await failSigned(operation.id, operation.state);

      // A deposit cannot spend a note twice, which is why this was originally
      // left open. It can still execute twice: the owner asked to move one
      // amount and would have moved two out of their public balance.
      await expect(
        liveishService().prepareOperation(
          operationInput({ clientNonce: "nonce-shield-dup-2", opType: "shield" }),
          actorContext
        )
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("finds the blocking operation however far back it is", async () => {
      const operation = await liveishService().prepareOperation(
        operationInput({ clientNonce: "nonce-far-back", opType: "shield" }),
        actorContext
      );
      expect(operation.state).toBe("indexing");
      await failSigned(operation.id, operation.state);

      // The stuck row is by definition old, and a wallet stays busy after it.
      // A guard that read a page of recent operations would lose sight of it
      // and leave the unique index to report a constraint name instead.
      const db = getDb(env);
      for (let index = 0; index < 60; index++) {
        await db
          .prepare(
            `INSERT INTO helius_rings_operations
               (id, organization_id, project_id, rings_connection_id, wallet_id, op_type, state, intent_key)
             VALUES (?, ?, ?, ?, ?, 'shield', 'completed', ?)`
          )
          .bind(
            `hro_filler_${index}`,
            TEST_ORG.id,
            TEST_PROJECT_ID,
            TEST_CONNECTION_ID,
            walletId,
            `sha256:filler_${index}`
          )
          .run();
      }

      await expect(
        liveishService().prepareOperation(
          operationInput({ clientNonce: "nonce-far-back-2", opType: "shield" }),
          actorContext
        )
      ).rejects.toMatchObject({ code: "conflict" });
    });

    describe("void", () => {
      async function strandedSignedFailure(
        nonce: string
      ): Promise<{ id: string; signature: string }> {
        const operation = await liveishService().prepareOperation(
          operationInput({ clientNonce: nonce, opType: "withdraw" }),
          actorContext
        );
        expect(operation.state).toBe("indexing");
        const signature = operation.outerTxSignature;
        if (!signature) throw new Error("stranded fixture has no signature");

        await createPostgresHeliusRingsOperationRepository(getDb(env)).failOperation({
          ...tenant,
          id: operation.id,
          expectedState: operation.state as "indexing",
          code: "manual_reconciliation_required",
          message: "signed bytes expired before photon indexed",
          retryable: false,
        });

        return { id: operation.id, signature };
      }

      it("voids and releases the wallet when the operator confirms the signature never landed", async () => {
        const operation = await strandedSignedFailure("nonce-void-ok");

        const result = await liveishService().voidOperation(
          operation.id,
          operation.signature,
          actorContext
        );

        expect(result.state).toBe("voided");

        await expect(
          liveishService().prepareOperation(
            operationInput({ clientNonce: "nonce-void-ok-2", opType: "withdraw" }),
            actorContext
          )
        ).resolves.toBeDefined();
      });

      it("refuses a signature that does not match the operation", async () => {
        const operation = await strandedSignedFailure("nonce-void-sig");

        await expect(
          liveishService().voidOperation(operation.id, "wrongsig", actorContext)
        ).rejects.toMatchObject({ code: "conflict" });
      });

      it("refuses to void a retryable failure", async () => {
        const operation = await liveishService().prepareOperation(
          operationInput({ clientNonce: "nonce-void-retry", opType: "withdraw" }),
          actorContext
        );
        const signature = operation.outerTxSignature;
        if (!signature) throw new Error("retryable fixture has no signature");
        await failSigned(operation.id, operation.state);

        await expect(
          liveishService().voidOperation(operation.id, signature, actorContext)
        ).rejects.toMatchObject({ code: "conflict" });
      });

      it("refuses an unsigned failure, which belongs to retry", async () => {
        const operation = await service({ gateway: new InMemoryRingsGateway() }).prepareOperation(
          operationInput({ clientNonce: "nonce-void-unsigned" }),
          actorContext
        );
        expect(operation.state).toBe("failed");

        await expect(
          liveishService().voidOperation(operation.id, "sig", actorContext)
        ).rejects.toMatchObject({ code: "conflict" });
      });

      it("is idempotent once voided", async () => {
        const operation = await strandedSignedFailure("nonce-void-replay");
        await liveishService().voidOperation(operation.id, operation.signature, actorContext);

        const replay = await liveishService().voidOperation(
          operation.id,
          operation.signature,
          actorContext
        );
        expect(replay.state).toBe("voided");
      });

      it("refuses to void when the signature actually landed and completes the row instead", async () => {
        const operation = await strandedSignedFailure("nonce-void-landed");

        // Fresh gateway that reports the signature indexed — Photon caught up
        // between the failure being recorded and the operator's assertion.
        const gateway = new InMemoryRingsGateway({
          buildUnsignedTx: () => unsignedShieldTransaction(1_000_000n),
        });
        gateway.recordSubmission(operation.signature);

        await expect(
          liveishService({ gateway }).voidOperation(operation.id, operation.signature, actorContext)
        ).rejects.toMatchObject({ code: "conflict" });

        const reloaded = await liveishService({ gateway }).getOperation(operation.id);
        expect(reloaded.state).toBe("completed");
      });
    });

    it("refuses to retry an operation that was already signed", async () => {
      const operation = await liveishService().prepareOperation(
        operationInput({ clientNonce: "nonce-signed-retry" }),
        actorContext
      );

      // It reached submission, so bytes exist. Fail it from there and ask for a
      // retry: rebuilding could select different notes and land beside a
      // transaction that may already have settled.
      await createPostgresHeliusRingsOperationRepository(getDb(env)).failOperation({
        ...tenant,
        id: operation.id,
        expectedState: operation.state as "indexing",
        code: "indexing_timeout",
        message: "photon never caught up",
        retryable: true,
      });

      await expect(
        liveishService().retryOperation(operation.id, "nonce-retry-attempt", actorContext)
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("records a spend against an unprovisioned wallet as bad input, not an outage", async () => {
      const wallets = createHeliusRingsWalletRepository(env);
      const fresh = await wallets.createWallet({
        ...tenant,
        sdpWalletId: "wal_unprovisioned_op",
        name: "Fresh",
        materialTag: "simulated",
      });
      if (!fresh) throw new Error("wallet fixture was not created");

      const operation = await liveishService().prepareOperation(
        operationInput({ clientNonce: "nonce-unprovisioned", walletId: fresh.id }),
        actorContext
      );

      // The wallet has no identity to spend from. Blaming the gateway would
      // point the operator at an outage that is not happening, and offering a
      // retry would never resolve it — the wallet has to be provisioned.
      expect(operation.failure).toMatchObject({ code: "invalid_input", retryable: false });
      expect(operation.failure?.message).toContain("no provisioned identity");
    });

    it("drives an allowed operation through sign and submit to indexing", async () => {
      const operation = await liveishService().prepareOperation(
        operationInput({ clientNonce: "nonce-live" }),
        actorContext
      );

      expect(operation.state).toBe("indexing");
      expect(operation.outerTxSignature).toBe(OUTER_TX.signature);
    });

    it("accepts policy-matching unsigned wire bytes before custody signing", async () => {
      const sign = vi.fn(
        async ({ unsignedTxBase64 }: { unsignedTxBase64: string }) =>
          (await signWalletTransaction(unsignedTxBase64)).signedTxBase64
      );
      const gateway = new InMemoryRingsGateway({
        buildUnsignedTx: () => unsignedShieldTransaction(1_000_000n),
      });

      const operation = await service({
        gateway,
        signOuterTransaction: sign,
        submitOuterTransaction: async () => OUTER_TX.signature,
      }).prepareOperation(operationInput({ clientNonce: "nonce-wire-valid" }), actorContext);

      expect(operation.state).toBe("indexing");
      expect(sign).toHaveBeenCalledOnce();
    });

    it("rejects changed signer message bytes before signed-byte persistence", async () => {
      const sign = vi.fn(async () => CHANGED_OUTER_TX.signedTxBase64);
      const submit = vi.fn(async () => OUTER_TX.signature);
      const gateway = new InMemoryRingsGateway({
        buildUnsignedTx: () => unsignedShieldTransaction(1_000_000n),
      });

      const operation = await service({
        gateway,
        signOuterTransaction: sign,
        submitOuterTransaction: submit,
      }).prepareOperation(operationInput({ clientNonce: "nonce-signer-modified" }), actorContext);

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "signer_failed", retryable: false });
      expect(operation.outerTxSignature).toBeNull();
      expect(submit).not.toHaveBeenCalled();
      const stored = await getDb(env)
        .prepare(
          "SELECT signed_transaction, submission_started_at FROM helius_rings_operations WHERE id = ?"
        )
        .bind(operation.id)
        .first<{ signed_transaction: string | null; submission_started_at: string | null }>();
      expect(stored).toEqual({ signed_transaction: null, submission_started_at: null });
    });

    it("fails tampered wire bytes non-retryably before custody signer invocation", async () => {
      const sign = vi.fn(async () => OUTER_TX.signedTxBase64);
      const gateway = new InMemoryRingsGateway({
        // The approved row says 1,000,000; only the encoded deposit amount was
        // changed after build.
        buildUnsignedTx: () => unsignedShieldTransaction(1_000_001n),
      });

      const operation = await service({
        gateway,
        signOuterTransaction: sign,
        submitOuterTransaction: async () => OUTER_TX.signature,
      }).prepareOperation(operationInput({ clientNonce: "nonce-wire-tampered" }), actorContext);

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "invalid_input", retryable: false });
      expect(operation.outerTxSignature).toBeNull();
      expect(sign).not.toHaveBeenCalled();
    });

    it("refuses merge before policy, proving, or persistence", async () => {
      const gateway = new InMemoryRingsGateway();
      const buildOperation = vi.spyOn(gateway, "buildOperation");

      await expect(
        liveishService({ gateway }).prepareOperation(
          operationInput({
            opType: "merge",
            asset: { mint: "So11111111111111111111111111111111111111112" },
            clientNonce: "nonce-merge-disabled",
          }),
          actorContext
        )
      ).rejects.toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("temporarily disabled"),
      });

      expect(buildOperation).not.toHaveBeenCalled();
    });

    it("persists the outer signature before broadcasting", async () => {
      const operation = await liveishService({
        submitOuterTransaction: async () => {
          throw new RingsAdapterError("submit_failed", "rpc down", { retryable: true });
        },
      }).prepareOperation(operationInput({ clientNonce: "nonce-submit" }), actorContext);

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "submit_failed", retryable: true });
      // The signature was durable before the RPC call, so a transaction that
      // landed anyway is still recoverable from the row.
      expect(operation.outerTxSignature).toBe(OUTER_TX.signature);
    });

    it("fails as signer_failed when the signer returns undecodable bytes", async () => {
      const operation = await liveishService({
        signOuterTransaction: async () => "c2lnbmVk",
      }).prepareOperation(operationInput({ clientNonce: "nonce-garbage" }), actorContext);

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "signer_failed", retryable: false });
    });

    it("takes the signer's fail edge when custody signing fails", async () => {
      const operation = await liveishService({
        signOuterTransaction: async () => {
          throw new RingsAdapterError("signer_failed", "signer down", { retryable: true });
        },
      }).prepareOperation(operationInput({ clientNonce: "nonce-signer" }), actorContext);

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "signer_failed", retryable: true });
    });
  });

  describe("executeOperation", () => {
    it("does not persist or broadcast when recovery failure wins a deferred signing race", async () => {
      const signerEntered = deferred<void>();
      const signerResult = deferred<string>();
      const submit = vi.fn(async () => OUTER_TX.signature);
      const svc = liveishService({
        signOuterTransaction: async () => {
          signerEntered.resolve(undefined);
          return signerResult.promise;
        },
        submitOuterTransaction: submit,
      });

      const original = svc.prepareOperation(
        operationInput({ clientNonce: "nonce-sign-race-failure-wins" }),
        actorContext
      );
      await signerEntered.promise;

      const operations = createPostgresHeliusRingsOperationRepository(getDb(env));
      const [ready] = await operations.listOperationsByWallet({ ...tenant, walletId });
      if (!ready) throw new Error("deferred signing operation was not persisted");
      expect(ready).toMatchObject({ state: "ready_to_sign", signed_transaction: null });

      const recovered = await svc.executeOperation(ready.id);
      expect(recovered).toMatchObject({
        state: "failed",
        failure: { code: "signer_failed", retryable: true },
      });

      signerResult.resolve(OUTER_TX.signedTxBase64);
      const settledOriginal = await original;
      expect(settledOriginal.state).toBe("failed");
      expect(submit).not.toHaveBeenCalled();
      expect(await operations.getOperationById({ ...tenant, id: ready.id })).toMatchObject({
        state: "failed",
        signed_transaction: null,
        outer_tx_signature: null,
      });
    });

    it("lets persisted bytes defeat a stale recovery failure and resume exact bytes", async () => {
      const actual = createPostgresHeliusRingsOperationRepository(getDb(env));
      const signerEntered = deferred<void>();
      const signerResult = deferred<string>();
      const failureEntered = deferred<void>();
      const allowFailure = deferred<void>();
      const signedPersisted = deferred<void>();
      const allowOriginalTransition = deferred<void>();
      const submit = vi.fn(async () => OUTER_TX.signature);

      const operations: HeliusRingsOperationRepository = {
        ...actual,
        persistSigned: async (input) => {
          const row = await actual.persistSigned(input);
          signedPersisted.resolve(undefined);
          return row;
        },
        failOperation: async (input) => {
          if (input.expectedState === "ready_to_sign") {
            failureEntered.resolve(undefined);
            await allowFailure.promise;
          }
          return actual.failOperation(input);
        },
        transitionState: async (input) => {
          if (input.expectedState === "ready_to_sign" && input.nextState === "submitted") {
            await allowOriginalTransition.promise;
          }
          return actual.transitionState(input);
        },
      };
      const svc = liveishService({
        operations,
        signOuterTransaction: async () => {
          signerEntered.resolve(undefined);
          return signerResult.promise;
        },
        submitOuterTransaction: submit,
      });

      const original = svc.prepareOperation(
        operationInput({ clientNonce: "nonce-sign-race-signed-wins" }),
        actorContext
      );
      await signerEntered.promise;
      const [ready] = await actual.listOperationsByWallet({ ...tenant, walletId });
      if (!ready) throw new Error("deferred signing operation was not persisted");

      const staleRecovery = svc.executeOperation(ready.id);
      await failureEntered.promise;
      signerResult.resolve(OUTER_TX.signedTxBase64);
      await signedPersisted.promise;
      expect(await actual.getOperationById({ ...tenant, id: ready.id })).toMatchObject({
        state: "ready_to_sign",
        signed_transaction: OUTER_TX.signedTxBase64,
      });

      allowFailure.resolve(undefined);
      const recoveryResult = await staleRecovery;
      expect(recoveryResult).toMatchObject({
        state: "ready_to_sign",
        outerTxSignature: OUTER_TX.signature,
        failure: null,
      });
      expect(submit).not.toHaveBeenCalled();

      const resumed = await liveishService({
        operations: actual,
        submitOuterTransaction: submit,
      }).executeOperation(ready.id);
      expect(resumed.state).toBe("submitted");
      expect(submit).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ signedTxBase64: OUTER_TX.signedTxBase64 })
      );

      allowOriginalTransition.resolve(undefined);
      expect((await original).state).toBe("submitted");
      expect(await actual.getOperationById({ ...tenant, id: ready.id })).toMatchObject({
        state: "submitted",
        signed_transaction: OUTER_TX.signedTxBase64,
        failure_code: null,
      });
    });

    it("refuses an existing merge row instead of resuming it", async () => {
      const operations = createPostgresHeliusRingsOperationRepository(getDb(env));
      const reserved = await operations.reserveIntent({
        ...tenant,
        ringsConnectionId: TEST_CONNECTION_ID,
        walletId,
        opType: "merge",
        intentKey: "sha256:existing-merge",
        assetMint: "So11111111111111111111111111111111111111112",
        amountRaw: null,
        fromAddr: null,
        toAddr: null,
        zoneId: null,
        transferMode: null,
        retryOfOperationId: null,
        timelock: null,
      });
      await getDb(env)
        .prepare("UPDATE helius_rings_operations SET state = 'proving' WHERE id = ?")
        .bind(reserved.operation.id)
        .run();

      await expect(service().executeOperation(reserved.operation.id)).rejects.toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("temporarily disabled"),
      });
    });

    it("advances only once the stored approval reads approved", async () => {
      let approvalStatus: "pending" | "approved" = "pending";
      const svc = liveishService({
        enforcePolicy: policyStub("approval_required", {
          requiresApproval: true,
          approvalRequestId: "apr_1",
        }),
        getApprovalStatus: async () => approvalStatus,
      });
      const paused = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-exec" }),
        actorContext
      );
      expect(paused.state).toBe("approval_required");

      // The verdict comes from the approval request, never the caller: while
      // it reads pending, execute is inert no matter how often it is called.
      const stillPaused = await svc.executeOperation(paused.id);
      expect(stillPaused.state).toBe("approval_required");

      approvalStatus = "approved";
      const advanced = await svc.executeOperation(paused.id);
      expect(advanced.state).toBe("indexing");
    });

    it("fails a rejected approval as non-retryable", async () => {
      const svc = liveishService({
        enforcePolicy: policyStub("approval_required", {
          requiresApproval: true,
          approvalRequestId: "apr_1",
        }),
        getApprovalStatus: async () => "rejected",
      });
      const paused = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-reject" }),
        actorContext
      );

      const rejected = await svc.executeOperation(paused.id);
      expect(rejected.state).toBe("failed");
      expect(rejected.failure).toMatchObject({ code: "approval_rejected", retryable: false });
    });

    it("polls indexing idempotently and completes on the Photon hit", async () => {
      let now = "2026-08-18T00:00:00.000Z";
      const gateway = new InMemoryRingsGateway({
        now: () => now,
        indexingDelayMs: 1000,
        buildUnsignedTx: () => unsignedShieldTransaction(1_000_000n),
      });
      const svc = liveishService({ gateway });
      const operation = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-index" }),
        actorContext
      );
      expect(operation.state).toBe("indexing");

      gateway.recordSubmission(OUTER_TX.signature);
      // Photon has not indexed yet: repeated polls change nothing.
      expect((await svc.executeOperation(operation.id)).state).toBe("indexing");
      expect((await svc.executeOperation(operation.id)).state).toBe("indexing");

      now = "2026-08-18T00:00:02.000Z";
      const completed = await svc.executeOperation(operation.id);
      expect(completed.state).toBe("completed");
      expect(completed.photonIndexedAt).toBe(now);

      // Executing a terminal operation is a no-op.
      expect((await svc.executeOperation(operation.id)).state).toBe("completed");
    });

    it("resumes a broadcast stranded in submitted", async () => {
      const gateway = new InMemoryRingsGateway({
        indexingDelayMs: 0,
        buildUnsignedTx: () => unsignedShieldTransaction(1_000_000n),
      });
      const svc = liveishService({ gateway });
      const operation = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-stranded" }),
        actorContext
      );
      expect(operation.state).toBe("indexing");

      // Exactly the row a process that died between the RPC broadcast and the
      // submitted → indexing commit leaves behind: the signature is durable,
      // the state never moved on.
      await getDb(env)
        .prepare("UPDATE helius_rings_operations SET state = 'submitted' WHERE id = ?")
        .bind(operation.id)
        .run();
      gateway.recordSubmission(OUTER_TX.signature);

      // One execute both advances it out of `submitted` and polls Photon, so a
      // stranded broadcast lands in reconciliation instead of sitting forever.
      const resumed = await svc.executeOperation(operation.id);
      expect(resumed.state).toBe("completed");
    });
  });

  describe("retryOperation", () => {
    it("files a linked retry and leaves the failed original untouched", async () => {
      const svc = retryableFailureService();
      const failed = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-retry" }),
        actorContext
      );
      expect(failed.state).toBe("failed");

      const retry = await svc.retryOperation(failed.id, "nonce-retry-2", actorContext);

      expect(retry.id).not.toBe(failed.id);
      expect(retry.intentKey).not.toBe(failed.intentKey);
      const original = await svc.getOperation(failed.id);
      expect(original.state).toBe("failed");

      const detail = await svc.getOperationWithEvents(retry.id);
      expect(detail.events.map((event) => event.kind)).toContain("operation.retried");
    });

    it("refuses to retry a historical merge operation", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const operations = createPostgresHeliusRingsOperationRepository(getDb(env));
      const reserved = await operations.reserveIntent({
        ...tenant,
        ringsConnectionId: TEST_CONNECTION_ID,
        walletId,
        opType: "merge",
        intentKey: "sha256:historical-merge",
        assetMint: mint,
        amountRaw: null,
        fromAddr: null,
        toAddr: null,
        zoneId: null,
        transferMode: null,
        retryOfOperationId: null,
        timelock: null,
      });
      const failed = await operations.failOperation({
        ...tenant,
        id: reserved.operation.id,
        expectedState: "draft",
        code: "gateway_unavailable",
        message: "historical merge failed",
        retryable: true,
      });
      if (!failed) throw new Error("failed merge fixture was not created");

      await expect(
        service().retryOperation(failed.id, "nonce-merge-retry-disabled", actorContext)
      ).rejects.toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("temporarily disabled"),
      });
    });

    it("refuses to retry a non-retryable failure", async () => {
      const svc = service({ enforcePolicy: policyStub("deny") });
      const denied = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-noretry" }),
        actorContext
      );

      await expect(
        svc.retryOperation(denied.id, "nonce-noretry-2", actorContext)
      ).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });

    it("caps the retry lineage depth", async () => {
      const svc = retryableFailureService();
      let current = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-depth-0" }),
        actorContext
      );
      expect(current.state).toBe("failed");

      // Depth 1 is the original; four retries reach the cap of five.
      for (let attempt = 1; attempt < 5; attempt++) {
        current = await svc.retryOperation(current.id, `nonce-depth-${attempt}`, actorContext);
        expect(current.state).toBe("failed");
      }

      await expect(
        svc.retryOperation(current.id, "nonce-depth-5", actorContext)
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("retry limit"),
      });
    });

    it("refuses to retry an operation that has not failed", async () => {
      const svc = liveishService();
      const inFlight = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-inflight" }),
        actorContext
      );
      expect(inFlight.state).toBe("indexing");

      await expect(svc.retryOperation(inFlight.id, "again", actorContext)).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });
  });

  describe("probeHealth", () => {
    it("records every component red when the port is not implemented", async () => {
      const health = await service().probeHealth();

      // Unobserved components read red, not green.
      expect(health.rpc).toBe("red");
      expect(health.prover).toBe("red");
      expect(health.photon).toBe("red");
    });

    it("records the gateway's component statuses when reachable", async () => {
      const health = await service({
        gateway: new InMemoryRingsGateway({
          health: { rpc: "green", prover: "amber", photon: "green" },
        }),
      }).probeHealth();

      expect(health).toMatchObject({ rpc: "green", prover: "amber", photon: "green" });
    });

    it("carries the probe's reason through to the response", async () => {
      // The response is rebuilt from the stored rows, so a reason the service
      // does not persist is a reason the operator never sees — which is what
      // made every classified probe failure invisible.
      const health = await service({
        gateway: new InMemoryRingsGateway({
          health: {
            rpc: "red",
            prover: "green",
            photon: "amber",
            detail: { rpc: "timed out", photon: "reported unhealthy" },
          },
        }),
      }).probeHealth();

      expect(health.detail).toMatchObject({
        "rpc.reason": "timed out",
        "photon.reason": "reported unhealthy",
      });
    });

    it("marks every component red when the probe itself throws", async () => {
      const gateway = new InMemoryRingsGateway();
      gateway.probeHealth = () => Promise.reject(new Error("boom"));

      const health = await service({ gateway }).probeHealth();

      // The probe is the only observer of these components, so a probe that
      // did not run leaves no evidence about any of them.
      expect(health).toMatchObject({
        rpc: "red",
        prover: "red",
        photon: "red",
      });
    });
  });

  describe("event feed", () => {
    it("records the full lifecycle on the timeline", async () => {
      const svc = liveishService();
      const operation = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-events" }),
        actorContext
      );

      const detail = await svc.getOperationWithEvents(operation.id);
      const kinds = detail.events.map((event) => event.kind);
      expect(kinds).toContain("operation.created");
      expect(kinds).toContain("policy.evaluated");
      expect(kinds).toContain("proof.received");
      expect(kinds).toContain("transaction.submitted");
    });
  });

  describe("project rings", () => {
    const RING_PROGRAM = "RingProgram1111111111111111111111111111111";
    const OTHER_RING = "RingProgram2111111111111111111111111111111";
    const LOOKUP_TABLE = "LookupTab1e11111111111111111111111111111111";

    const provisioned = async () => ({
      auditorPublicKeyHex: "04ff",
      lookupTableAddress: LOOKUP_TABLE,
    });

    async function seedActiveRing(name = "treasury", ringProgramId = RING_PROGRAM) {
      const rings = createHeliusRingsProjectRingRepository(env);
      await rings.reserveRing({ ...tenant, name, ringProgramId });
      await rings.markActive({
        ...tenant,
        name,
        ringProgramId,
        auditorPublicKey: "04ff",
        lookupTableAddress: LOOKUP_TABLE,
      });
    }

    it("records a named ring and activates it with the auditor key and lookup table", async () => {
      const svc = service({ gateway: gatewayStub({ provisionRing: provisioned }) });

      const ring = await svc.createProjectRing({ name: "treasury", ringProgramId: RING_PROGRAM });

      expect(ring).toMatchObject({
        name: "treasury",
        ringProgramId: RING_PROGRAM,
        status: "active",
        auditorPublicKeyHex: "04ff",
        lookupTableAddress: LOOKUP_TABLE,
        failure: null,
      });
      expect(await svc.listProjectRings()).toMatchObject([
        { name: "treasury", status: "active", auditorPublicKeyHex: "04ff" },
      ]);
    });

    it("keeps rings with distinct names side by side, oldest first", async () => {
      const svc = service({ gateway: gatewayStub({ provisionRing: provisioned }) });

      await svc.createProjectRing({ name: "treasury", ringProgramId: RING_PROGRAM });
      await svc.createProjectRing({ name: "payroll", ringProgramId: OTHER_RING });

      expect((await svc.listProjectRings()).map((ring) => ring.name)).toEqual([
        "treasury",
        "payroll",
      ]);
    });

    it("refuses a name outside the slug shape and the reserved word", async () => {
      const svc = service({ gateway: gatewayStub({}) });

      for (const name of ["Treasury", "default", "-x-"]) {
        await expect(
          svc.createProjectRing({ name, ringProgramId: RING_PROGRAM })
        ).rejects.toMatchObject({ code: "invalid_input" });
      }
    });

    it("refuses one program under two names", async () => {
      await service({ gateway: gatewayStub({ provisionRing: provisioned }) }).createProjectRing({
        name: "treasury",
        ringProgramId: RING_PROGRAM,
      });

      // One on-chain pool under two rows would split its audit trail.
      await expect(
        service({ gateway: gatewayStub({}) }).createProjectRing({
          name: "payroll",
          ringProgramId: RING_PROGRAM,
        })
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("registers rings without a cap and lets an existing name resume", async () => {
      const svc = service({ gateway: gatewayStub({ provisionRing: provisioned }) });
      const programId = (index: number) => `RingProgram${index}11111111111111111111111111111`;
      // No MAX_PROJECT_RINGS ceiling: a project registers as many as ops deploys.
      for (let index = 1; index <= 12; index += 1) {
        expect(
          await svc.createProjectRing({ name: `ring-${index}`, ringProgramId: programId(index) })
        ).toMatchObject({ status: "active" });
      }

      // Re-submitting an existing name is a resume, not a new ring.
      expect(
        await svc.createProjectRing({ name: "ring-1", ringProgramId: programId(1) })
      ).toMatchObject({ status: "active" });
    });

    it("returns an active ring as it stands without re-running bring-up", async () => {
      await service({ gateway: gatewayStub({ provisionRing: provisioned }) }).createProjectRing({
        name: "treasury",
        ringProgramId: RING_PROGRAM,
      });

      // The stub's default provisionRing throws, so reaching the gateway again
      // would fail this test with its "not expected" error instead of the replay.
      const replay = await service({ gateway: gatewayStub({}) }).createProjectRing({
        name: "treasury",
        ringProgramId: RING_PROGRAM,
      });

      expect(replay).toMatchObject({ status: "active", auditorPublicKeyHex: "04ff" });
    });

    it("re-points a never-active ring at a corrected program id", async () => {
      // A mistyped id records a failure and can never activate...
      await expect(
        service({
          gateway: gatewayStub({
            provisionRing: async () => {
              throw new HeliusRingsError("invalid_input", "not a deployed program");
            },
          }),
        }).createProjectRing({ name: "treasury", ringProgramId: RING_PROGRAM })
      ).rejects.toMatchObject({ code: "invalid_input" });

      // ...so submitting the corrected id under the same name replaces it and
      // runs bring-up against it.
      const bringUps: string[] = [];
      const ring = await service({
        gateway: gatewayStub({
          provisionRing: async ({ ringProgramId }) => {
            bringUps.push(ringProgramId);
            return { auditorPublicKeyHex: "04ff", lookupTableAddress: LOOKUP_TABLE };
          },
        }),
      }).createProjectRing({ name: "treasury", ringProgramId: OTHER_RING });

      expect(bringUps).toEqual([OTHER_RING]);
      expect(ring).toMatchObject({
        ringProgramId: OTHER_RING,
        status: "active",
        failure: null,
      });
    });

    it("refuses to re-point a name away from an active ring", async () => {
      await service({ gateway: gatewayStub({ provisionRing: provisioned }) }).createProjectRing({
        name: "treasury",
        ringProgramId: RING_PROGRAM,
      });

      // Re-pointing an active ring would strand every note bound to it.
      await expect(
        service({ gateway: gatewayStub({}) }).createProjectRing({
          name: "treasury",
          ringProgramId: OTHER_RING,
        })
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await service({ gateway: gatewayStub({}) }).listProjectRings()).toMatchObject([
        { ringProgramId: RING_PROGRAM, status: "active" },
      ]);
    });

    it("records a domain failure on the row and resumes on re-submission", async () => {
      const failing = service({
        gateway: gatewayStub({
          provisionRing: async () => {
            throw new HeliusRingsError("gateway_unavailable", "a Rings upstream is unavailable");
          },
        }),
      });

      await expect(
        failing.createProjectRing({ name: "treasury", ringProgramId: RING_PROGRAM })
      ).rejects.toMatchObject({ code: "gateway_unavailable" });
      expect(await failing.listProjectRings()).toMatchObject([
        {
          status: "failed",
          failure: { code: "gateway_unavailable", message: "a Rings upstream is unavailable" },
        },
      ]);

      // Same name and id, healthy gateway: the failed row is the resume point.
      const resumed = await service({
        gateway: gatewayStub({ provisionRing: provisioned }),
      }).createProjectRing({ name: "treasury", ringProgramId: RING_PROGRAM });
      expect(resumed).toMatchObject({ status: "active", failure: null });
    });

    it("records only a fixed message for a non-domain failure", async () => {
      const svc = service({
        gateway: gatewayStub({
          provisionRing: async () => {
            // e.g. a transport error quoting the endpoint, which carries an API key.
            throw new Error("fetch failed: https://rpc.example/?api-key=super-secret");
          },
        }),
      });

      await expect(
        svc.createProjectRing({ name: "treasury", ringProgramId: RING_PROGRAM })
      ).rejects.toThrow("fetch failed");

      const [ring] = await svc.listProjectRings();
      expect(ring?.failure).toEqual({
        code: "gateway_unavailable",
        message: "ring bring-up failed",
      });
    });

    it("pins the named ring on a shield and keys the intent by it", async () => {
      await seedActiveRing();

      const input = operationInput({ ring: "treasury", clientNonce: "nonce-ring-pin" });
      const operation = await liveishService().prepareOperation(input, actorContext);

      expect(operation.state).toBe("indexing");
      expect(operation.ringProgramId).toBe(RING_PROGRAM);
      // The resolved id joins the idempotency key: the same shield without the
      // ring reserves a second operation instead of replaying this one.
      expect(operation.intentKey).toBe(computeIntentKey(input, RING_PROGRAM));
      expect(computeIntentKey(input, RING_PROGRAM)).not.toBe(computeIntentKey(input, null));
    });

    it("pins the named ring on a withdraw and threads its lookup table to the build and the wire policy", async () => {
      await seedActiveRing();

      const gateway = new InMemoryRingsGateway({
        buildUnsignedTx: () => unsignedShieldTransaction(1_000_000n),
      });
      const builds: BuildOperationInput[] = [];
      const buildOperation = gateway.buildOperation.bind(gateway);
      gateway.buildOperation = async (input) => {
        builds.push(input);
        return buildOperation(input);
      };
      const policyInputs: RingsOuterTransactionPolicyInput[] = [];

      const operation = await liveishService({
        gateway,
        validateOuterTransaction: async (input) => {
          policyInputs.push(input);
        },
      }).prepareOperation(
        operationInput({ opType: "withdraw", ring: "treasury", clientNonce: "nonce-ring-spend" }),
        actorContext
      );

      expect(operation.state).toBe("indexing");
      expect(operation.ringProgramId).toBe(RING_PROGRAM);
      expect(builds[0]?.ring).toEqual({ programId: RING_PROGRAM, lookupTable: LOOKUP_TABLE });
      expect(policyInputs[0]?.intent).toMatchObject({
        opType: "withdraw",
        ring: { programId: RING_PROGRAM, lookupTable: LOOKUP_TABLE },
      });
    });

    it("resolves the same named ring on every enabled operation type", async () => {
      await seedActiveRing();
      // No shield-only guard remains: the selector resolves before reserve for
      // all three op types, so intent keys are ring-sensitive on spends too.
      const input = operationInput({
        opType: "withdraw",
        ring: "treasury",
        clientNonce: "nonce-ring-withdraw-key",
      });
      const operation = await liveishService().prepareOperation(input, actorContext);
      expect(operation.intentKey).toBe(computeIntentKey(input, RING_PROGRAM));
    });

    it("refuses a name the project never recorded before reserving", async () => {
      // The request names a ring the project does not have: the caller's to fix.
      await expect(
        liveishService().prepareOperation(
          operationInput({ ring: "treasury", clientNonce: "nonce-ring-none" }),
          actorContext
        )
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(
        await createPostgresHeliusRingsOperationRepository(getDb(env)).listOperationsByWallet({
          ...tenant,
          walletId,
        })
      ).toHaveLength(0);
    });

    it("refuses a named ring while bring-up is unfinished", async () => {
      await createHeliusRingsProjectRingRepository(env).reserveRing({
        ...tenant,
        name: "treasury",
        ringProgramId: RING_PROGRAM,
      });

      // An operator action (completing bring-up) makes the same request succeed.
      await expect(
        liveishService().prepareOperation(
          operationInput({ ring: "treasury", clientNonce: "nonce-ring-pending" }),
          actorContext
        )
      ).rejects.toMatchObject({ code: "config_error" });
    });

    it("retries a shield with the pinned ring rather than re-resolving the selector", async () => {
      await seedActiveRing();

      const failed = await retryableFailureService().prepareOperation(
        operationInput({ ring: "treasury", clientNonce: "nonce-ring-retry" }),
        actorContext
      );
      expect(failed.state).toBe("failed");
      expect(failed.ringProgramId).toBe(RING_PROGRAM);

      // The ring row is gone before the retry runs, so the pinned id on the
      // failed row is the only ring source left — re-resolving the selector
      // here would fail as invalid_input instead of reaching indexing.
      await getDb(env)
        .prepare("DELETE FROM helius_rings_project_rings WHERE project_id = ?")
        .bind(TEST_PROJECT_ID)
        .run();

      const retried = await liveishService().retryOperation(
        failed.id,
        "nonce-ring-retry-2",
        actorContext
      );
      expect(retried.state).toBe("indexing");
      expect(retried.ringProgramId).toBe(RING_PROGRAM);
    });

    it("fails a ring spend as config_error when the ring row lost its bring-up", async () => {
      await seedActiveRing();

      const failed = await retryableFailureService().prepareOperation(
        operationInput({
          opType: "withdraw",
          ring: "treasury",
          clientNonce: "nonce-ring-spend-cfg",
        }),
        actorContext
      );
      expect(failed.state).toBe("failed");

      // Unlike a shield, a spend needs the ring row again at build time — its
      // lookup table is the transport the v0 transaction rides.
      await getDb(env)
        .prepare("DELETE FROM helius_rings_project_rings WHERE project_id = ?")
        .bind(TEST_PROJECT_ID)
        .run();

      const retried = await liveishService().retryOperation(
        failed.id,
        "nonce-ring-spend-cfg-2",
        actorContext
      );
      expect(retried.state).toBe("failed");
      expect(retried.failure?.code).toBe("config_error");
    });
  });
});

describe("computeIntentKey", () => {
  it("is deterministic, nonce-sensitive and ring-sensitive", () => {
    const base: PrivateOperationInput = {
      walletId: "hrw_1",
      opType: "shield",
      clientNonce: "n1",
    };
    const RING_PROGRAM = "RingProgram1111111111111111111111111111111";

    expect(computeIntentKey(base, null)).toBe(computeIntentKey({ ...base }, null));
    expect(computeIntentKey(base, null)).not.toBe(
      computeIntentKey({ ...base, clientNonce: "n2" }, null)
    );
    // Same input, different ring: a second operation, never a replay.
    expect(computeIntentKey(base, null)).not.toBe(computeIntentKey(base, RING_PROGRAM));
    expect(computeIntentKey(base, null)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
