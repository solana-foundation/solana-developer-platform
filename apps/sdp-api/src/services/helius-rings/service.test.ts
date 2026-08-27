import type {
  PrivateOperationInput,
  ReadIdentityInput,
  ReadIdentityResult,
  SyncPhotonInput,
  SyncPhotonResult,
} from "@sdp/helius-rings";
import { HeliusRingsError, SecretRef } from "@sdp/helius-rings";
import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import type { PolicyDecision } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  createHeliusRingsOperationRepository,
  createHeliusRingsWalletRepository,
} from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { gatewayStub, pipelineGateway } from "@/test/fixtures/rings-gateway";
import { signedRingsTransaction } from "@/test/fixtures/rings-transactions";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { RingsAdapterError } from "./adapter-error";
import {
  computeIntentKey,
  createHeliusRingsService,
  type HeliusRingsServiceDependencies,
} from "./service";

const TEST_PROJECT_ID = "prj_hrs_service_test";
const tenant = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };

let walletId: string;

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
  return {
    walletId,
    opType: "shield",
    asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1000000" },
    clientNonce: "nonce-1",
    ...overrides,
  };
}

const actorContext = { apiKeyId: "key_1", actor: null, custodyWalletId: "cw_1" };

function service(deps: HeliusRingsServiceDependencies = {}) {
  return createHeliusRingsService(env, tenant, {
    enforcePolicy: policyStub("allow"),
    ...deps,
  });
}

const OUTER_TX = signedRingsTransaction(7);

const OWNER = "HrsOwnerPublicKey1111111111111111111111111111";

function syncResult(overrides: Partial<SyncPhotonResult> = {}): SyncPhotonResult {
  return {
    cursor: "2026-08-26T12:00:00.000Z",
    balances: [
      {
        mint: "So11111111111111111111111111111111111111112",
        // Past 2^53: the whole reason amounts stay decimal strings.
        amountRaw: "18446744073709551615",
        decimals: 9,
        symbol: "SOL",
      },
    ],
    indexedOperationSignatures: [],
    degraded: false,
    ...overrides,
  };
}

/** A rings wallet with a shielded identity, as provisioning would leave it. */
async function provisionedWallet(shieldedAddress = "rings1provisioned"): Promise<string> {
  const wallet = await service({
    gateway: gatewayStub({
      provisionIdentity: async () => ({ shieldedAddress, materialTag: "live" }),
    }),
  }).provisionPrivateWallet({
    sdpWalletId: `wal_sync_${shieldedAddress}`,
    sdpAddress: OWNER,
    name: "Sync",
  });
  return wallet.id;
}

/**
 * A service whose gateway succeeds and whose sign/submit adapters are stubbed.
 * The signer returns real wire bytes; the service derives the signature from them.
 */
function liveishService(deps: HeliusRingsServiceDependencies = {}) {
  return service({
    gateway: pipelineGateway(),
    signOuterTransaction: async () => OUTER_TX.signedTxBase64,
    submitOuterTransaction: async () => OUTER_TX.signature,
    ...deps,
  });
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

    const wallet = await createHeliusRingsWalletRepository(env).createWallet({
      ...tenant,
      sdpWalletId: "wal_hrs_service_test",
      name: "Treasury",
      materialTag: "simulated",
    });
    if (!wallet) throw new Error("wallet fixture was not created");
    walletId = wallet.id;
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
      const wallet = await service({
        gateway: gatewayStub({
          provisionIdentity: async () => ({
            shieldedAddress: "rings1provisioned",
            materialTag: "live",
          }),
        }),
      }).provisionPrivateWallet({
        sdpWalletId: "wal_prov_1",
        sdpAddress: "addr1",
        name: "Ops",
      });

      expect(wallet.status).toBe("ready");
      expect(wallet.shieldedAddress).toMatch(/^rings1/);
    });

    // Inferring the tag instead of taking the gateway's would let a simulated
    // wallet pass for one holding real funds.
    it.each(["live", "simulated"] as const)(
      "persists the gateway's %s tag",
      async (materialTag) => {
        const gateway = gatewayStub({
          provisionIdentity: async () => ({ shieldedAddress: "rings1abc", materialTag }),
        });

        const wallet = await service({ gateway }).provisionPrivateWallet({
          sdpWalletId: `wal_tag_${materialTag}`,
          sdpAddress: "addr1",
          name: "Ops",
        });

        expect(wallet).toMatchObject({
          status: "ready",
          shieldedAddress: "rings1abc",
          materialTag,
        });
        const row = await createHeliusRingsWalletRepository(env).getWalletById({
          ...tenant,
          id: wallet.id,
        });
        expect(row?.material_tag).toBe(materialTag);
      }
    );

    it("leaves the wallet pending when the upstreams are unconfigured", async () => {
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
  });

  describe("syncWallet", () => {
    it("reads balances, records the observation and reports it as clean", async () => {
      const id = await provisionedWallet("rings1sync_ok");
      const observed = syncResult();

      const synced = await service({
        gateway: gatewayStub({ syncPhoton: async () => observed }),
      }).syncWallet(id, OWNER);

      expect(synced).toEqual({
        balances: observed.balances,
        degraded: false,
        observedAt: observed.cursor,
      });
      // uint64 all the way out; a JSON number would have rounded it.
      expect(synced.balances[0]?.amountRaw).toBe("18446744073709551615");
      const row = await createHeliusRingsWalletRepository(env).getWalletById({ ...tenant, id });
      expect(row?.sync_cursor).toBe(observed.cursor);
    });

    it("carries the degraded flag through rather than dropping it", async () => {
      const id = await provisionedWallet("rings1sync_degraded");

      const synced = await service({
        gateway: gatewayStub({ syncPhoton: async () => syncResult({ degraded: true }) }),
      }).syncWallet(id, OWNER);

      expect(synced).toMatchObject({ degraded: true });
      expect(synced.balances).toHaveLength(1);
    });

    it("labels an allowlisted mint from the platform table, not UNKNOWN", async () => {
      const id = await provisionedWallet("rings1sync_usdc");
      const usdc = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

      const synced = await service({
        gateway: gatewayStub({
          syncPhoton: async () =>
            syncResult({
              balances: [{ mint: usdc, amountRaw: "1000000", decimals: null, symbol: "UNKNOWN" }],
            }),
        }),
      }).syncWallet(id, OWNER);

      expect(synced.balances[0]).toEqual({
        mint: usdc,
        amountRaw: "1000000",
        decimals: 6,
        symbol: "USDC",
      });
    });

    // A derivation mismatch must fail rather than answer with someone else's
    // balances.
    it("pins the stored shielded address and the owner on every read", async () => {
      const id = await provisionedWallet("rings1sync_pinned");
      const seen: SyncPhotonInput[] = [];

      await service({
        gateway: gatewayStub({
          syncPhoton: async (input) => {
            seen.push(input);
            return syncResult();
          },
        }),
      }).syncWallet(id, OWNER);

      expect(seen[0]).toMatchObject({
        walletId: id,
        owner: OWNER,
        expectedShieldedAddress: "rings1sync_pinned",
        cursor: null,
      });
    });

    it("passes the recorded cursor back on a second sync", async () => {
      const id = await provisionedWallet("rings1sync_second");
      const seen: SyncPhotonInput[] = [];
      const svc = service({
        gateway: gatewayStub({
          syncPhoton: async (input) => {
            seen.push(input);
            return syncResult({ cursor: `observed:${seen.length}` });
          },
        }),
      });

      await svc.syncWallet(id, OWNER);
      await svc.syncWallet(id, OWNER);

      expect(seen[0]?.cursor).toBeNull();
      expect(seen[1]?.cursor).toBe("observed:1");
    });

    it("refuses a wallet that has no shielded identity yet", async () => {
      const error = await service({
        gateway: gatewayStub({ syncPhoton: async () => syncResult() }),
      })
        .syncWallet(walletId, OWNER)
        .then(
          () => null,
          (thrown: unknown) => thrown
        );

      expect(error).toBeInstanceOf(HeliusRingsError);
      expect(error).toMatchObject({ code: "invalid_input" });
      const row = await createHeliusRingsWalletRepository(env).getWalletById({
        ...tenant,
        id: walletId,
      });
      expect(row?.sync_cursor).toBeNull();
    });

    // There is no safe default for whose balances to read.
    it("refuses when custody controls no wallet for the owner", async () => {
      const id = await provisionedWallet("rings1sync_no_owner");

      await expect(
        service({ gateway: gatewayStub({}) }).syncWallet(id, null)
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("404s an unknown wallet", async () => {
      await expect(service().syncWallet("hrw_missing", OWNER)).rejects.toBeInstanceOf(AppError);
    });

    it("does not advance the cursor when the gateway fails", async () => {
      const id = await provisionedWallet("rings1sync_failed");

      await expect(
        service({
          gateway: gatewayStub({
            syncPhoton: async () => {
              throw new HeliusRingsError("config_error", "HELIUS_RINGS_INDEXER_URL is not set");
            },
          }),
        }).syncWallet(id, OWNER)
      ).rejects.toMatchObject({ code: "config_error" });

      const row = await createHeliusRingsWalletRepository(env).getWalletById({ ...tenant, id });
      expect(row?.sync_cursor).toBeNull();
    });
  });

  describe("readWalletIdentity", () => {
    function identityResult(overrides: Partial<ReadIdentityResult> = {}): ReadIdentityResult {
      return {
        status: "ours",
        derivedShieldedAddress: "rings1derived",
        publishedShieldedAddress: "rings1derived",
        mismatch: null,
        ...overrides,
      };
    }

    it("reports the identity our own row records alongside the chain's", async () => {
      const id = await provisionedWallet("rings1identity_ours");

      const identity = await service({
        gateway: gatewayStub({ readIdentity: async () => identityResult() }),
      }).readWalletIdentity(id, OWNER);

      expect(identity).toEqual({
        ...identityResult(),
        recordedShieldedAddress: "rings1identity_ours",
      });
    });

    // The wallet this exists for: provisioning refused, so nothing was recorded.
    it("answers for a pending wallet that has no shielded address at all", async () => {
      const identity = await service({
        gateway: gatewayStub({
          readIdentity: async () =>
            identityResult({
              status: "foreign",
              publishedShieldedAddress: "rings1someone_else",
              mismatch: "nullifier_key",
            }),
        }),
      }).readWalletIdentity(walletId, OWNER);

      expect(identity).toMatchObject({
        status: "foreign",
        mismatch: "nullifier_key",
        recordedShieldedAddress: null,
      });
    });

    it("passes the wallet id and the owner to the port", async () => {
      const seen: ReadIdentityInput[] = [];
      const id = await provisionedWallet("rings1identity_pinned");

      await service({
        gateway: gatewayStub({
          readIdentity: async (input) => {
            seen.push(input);
            return identityResult();
          },
        }),
      }).readWalletIdentity(id, OWNER);

      expect(seen[0]).toEqual({ walletId: id, owner: OWNER });
    });

    // There is no default account whose record to read.
    it("refuses a null owner", async () => {
      await expect(
        service({ gateway: gatewayStub({}) }).readWalletIdentity(walletId, null)
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("404s an unknown wallet", async () => {
      await expect(service().readWalletIdentity("hrw_missing", OWNER)).rejects.toBeInstanceOf(
        AppError
      );
    });

    it("leaves the wallet row exactly as it found it", async () => {
      const id = await provisionedWallet("rings1identity_readonly");
      const wallets = createHeliusRingsWalletRepository(env);
      const before = await wallets.getWalletById({ ...tenant, id });

      await service({
        gateway: gatewayStub({ readIdentity: async () => identityResult() }),
      }).readWalletIdentity(id, OWNER);

      expect(await wallets.getWalletById({ ...tenant, id })).toEqual(before);
    });

    it("surfaces the unconfigured gateway's refusal rather than guessing", async () => {
      const id = await provisionedWallet("rings1identity_unconfigured");

      await expect(service().readWalletIdentity(id, OWNER)).rejects.toMatchObject({
        code: "config_error",
      });
    });
  });

  describe("prepareOperation", () => {
    it("is idempotent: the same client nonce returns the same operation", async () => {
      const svc = service();
      const first = await svc.prepareOperation(operationInput(), actorContext);
      const replay = await svc.prepareOperation(operationInput(), actorContext);

      expect(replay.id).toBe(first.id);
      expect(replay.intentKey).toBe(computeIntentKey(operationInput()));
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

    it("fails honestly at the port when the upstreams are unconfigured", async () => {
      const operation = await service().prepareOperation(
        operationInput({ clientNonce: "nonce-unconfigured" }),
        actorContext
      );

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "gateway_unavailable", retryable: true });
    });

    it("maps a domain invalid_input onto the operation's fail edge", async () => {
      const operation = await liveishService({
        gateway: pipelineGateway({
          buildOperation: async () => {
            throw new HeliusRingsError("invalid_input", "a shield needs an asset and an amount");
          },
        }),
      }).prepareOperation(operationInput({ clientNonce: "nonce-invalid" }), actorContext);

      expect(operation.state).toBe("failed");
      expect(operation.failure).toMatchObject({ code: "invalid_input", retryable: false });
    });

    it("refuses a mint that is not on the asset allowlist before reserving", async () => {
      await expect(
        service().prepareOperation(
          operationInput({
            clientNonce: "nonce-allowlist",
            asset: { mint: "NotOnTheAllowlist111111111111111111111111", amountRaw: "1" },
          }),
          actorContext
        )
      ).rejects.toMatchObject({
        code: "invalid_input",
        message: "this mint is not on the Rings asset allowlist",
      });

      const rows = await createHeliusRingsOperationRepository(env).listOperationsByWallet({
        ...tenant,
        walletId,
      });
      expect(rows).toEqual([]);
    });

    it("stamps the backing owner as from on a shield", async () => {
      const captured: string[] = [];
      const operation = await liveishService({
        gateway: pipelineGateway({
          buildOperation: async ({ operation: built }) => {
            captured.push(built.input.from ?? "");
            return {
              outerUnsignedTxBase64: "dW5zaWduZWQ=",
              requiredSigners: [OWNER],
              ringsMetadata: new SecretRef({ seed: "pipeline" }),
            };
          },
        }),
      }).prepareOperation(operationInput({ clientNonce: "nonce-from" }), {
        ...actorContext,
        owner: OWNER,
      });

      expect(operation.state).toBe("indexing");
      expect(captured).toEqual([OWNER]);
      expect(operation.input.from).toBe(OWNER);
    });

    it("drives an allowed operation through sign and submit to indexing", async () => {
      const operation = await liveishService().prepareOperation(
        operationInput({ clientNonce: "nonce-live" }),
        actorContext
      );

      expect(operation.state).toBe("indexing");
      expect(operation.outerTxSignature).toBe(OUTER_TX.signature);
    });

    // The RPC can throw after the node accepted the transaction. Failing here
    // would make it retryable, and a retry would shield the amount twice.
    it("carries a broadcast it cannot confirm into indexing rather than failing it", async () => {
      const operation = await liveishService({
        submitOuterTransaction: async () => {
          throw new RingsAdapterError("submit_failed", "rpc down", { retryable: true });
        },
      }).prepareOperation(operationInput({ clientNonce: "nonce-submit" }), actorContext);

      expect(operation.state).toBe("indexing");
      expect(operation.failure).toBeNull();
      // The signature was durable before the RPC call, so Photon can be asked.
      expect(operation.outerTxSignature).toBe(OUTER_TX.signature);
    });

    it("records on the timeline that the broadcast was never acknowledged", async () => {
      const service = liveishService({
        submitOuterTransaction: async () => {
          throw new RingsAdapterError("submit_failed", "rpc down", { retryable: true });
        },
      });
      const operation = await service.prepareOperation(
        operationInput({ clientNonce: "nonce-submit-event" }),
        actorContext
      );

      const detailed = await service.getOperationWithEvents(operation.id);
      const submitted = detailed.events.find((event) => event.kind === "transaction.submitted");

      expect(submitted?.payload).toMatchObject({ broadcast: "unconfirmed" });
    });

    it("marks an acknowledged broadcast as accepted", async () => {
      const service = liveishService();
      const operation = await service.prepareOperation(
        operationInput({ clientNonce: "nonce-submit-ok" }),
        actorContext
      );

      const detailed = await service.getOperationWithEvents(operation.id);
      const submitted = detailed.events.find((event) => event.kind === "transaction.submitted");

      expect(submitted?.payload).toMatchObject({ broadcast: "accepted" });
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

    /**
     * The signing-timeout sweep firing while custody is still working. Both
     * writers compare-and-swap on the expected state, so the sweep winning must
     * mean the broadcast never runs — which keeps its `retryable` honest.
     */
    describe("when the signing sweep wins the race out of ready_to_sign", () => {
      function racedService() {
        const repository = createHeliusRingsOperationRepository(env);
        let submitCalls = 0;

        const service = liveishService({
          signOuterTransaction: async () => {
            const [inFlight] = await repository.listInFlightOperations({
              staleBefore: new Date(Date.now() + 60_000).toISOString(),
              limit: 10,
            });
            if (!inFlight) throw new Error("expected an operation in flight to sweep");
            await repository.failOperation({
              ...tenant,
              id: inFlight.id,
              expectedState: "ready_to_sign",
              code: "signer_failed",
              message: "the operation was abandoned before its signature was recorded",
              retryable: true,
            });
            return OUTER_TX.signedTxBase64;
          },
          submitOuterTransaction: async () => {
            submitCalls += 1;
            return OUTER_TX.signature;
          },
        });

        return { service, submitCalls: () => submitCalls };
      }

      it("never broadcasts, so the swept row's account of itself stays true", async () => {
        const raced = racedService();

        const operation = await raced.service.prepareOperation(
          operationInput({ clientNonce: "nonce-sweep-race" }),
          actorContext
        );

        expect(raced.submitCalls()).toBe(0);
        expect(operation.state).toBe("failed");
        expect(operation.failure).toMatchObject({ code: "signer_failed", retryable: true });
      });

      it("records the signature it threw away rather than losing it silently", async () => {
        const raced = racedService();
        const operation = await raced.service.prepareOperation(
          operationInput({ clientNonce: "nonce-sweep-race-event" }),
          actorContext
        );

        const detailed = await raced.service.getOperationWithEvents(operation.id);
        const discarded = detailed.events.find((event) => event.kind === "signature.discarded");

        // Otherwise the timeline claims no signature existed when custody had
        // produced a valid one.
        expect(discarded?.payload).toMatchObject({ signature: OUTER_TX.signature });
      });
    });
  });

  describe("executeOperation", () => {
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

      // The verdict comes from the approval request, never the caller.
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
      const INDEXED_AT = "2026-08-18T00:00:02.000Z";
      let indexed = false;
      const svc = liveishService({
        gateway: pipelineGateway({
          verifyIndexed: async () =>
            indexed ? { indexedAt: INDEXED_AT, photonRef: "photon:1" } : null,
        }),
      });
      const operation = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-index" }),
        actorContext
      );
      expect(operation.state).toBe("indexing");

      // Photon has not indexed yet: repeated polls change nothing.
      expect((await svc.executeOperation(operation.id)).state).toBe("indexing");
      expect((await svc.executeOperation(operation.id)).state).toBe("indexing");

      indexed = true;
      const completed = await svc.executeOperation(operation.id);
      expect(completed.state).toBe("completed");
      expect(completed.photonIndexedAt).toBe(INDEXED_AT);

      expect((await svc.executeOperation(operation.id)).state).toBe("completed");
    });

    it("resumes a broadcast stranded in submitted", async () => {
      const svc = liveishService({
        gateway: pipelineGateway({
          verifyIndexed: async () => ({
            indexedAt: "2026-08-18T00:00:00.000Z",
            photonRef: "photon:1",
          }),
        }),
      });
      const operation = await svc.prepareOperation(
        operationInput({ clientNonce: "nonce-stranded" }),
        actorContext
      );
      expect(operation.state).toBe("indexing");

      // The row a process that died between the RPC broadcast and the
      // submitted → indexing commit leaves behind.
      await getDb(env)
        .prepare("UPDATE helius_rings_operations SET state = 'submitted' WHERE id = ?")
        .bind(operation.id)
        .run();

      const resumed = await svc.executeOperation(operation.id);
      expect(resumed.state).toBe("completed");
    });
  });

  describe("retryOperation", () => {
    it("files a linked retry and leaves the failed original untouched", async () => {
      const svc = service();
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
      const svc = service();
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
    /**
     * The reason has to survive the round trip through the health rows, because
     * the response is rebuilt from them.
     */
    it("surfaces the missing variables when the upstreams are unconfigured", async () => {
      const health = await service().probeHealth();

      // Unobserved components read red, not green.
      expect(health).toMatchObject({ rpc: "red", photon: "red", prover: "red", gateway: "red" });
      expect(health.detail?.["gateway.reason"]).toContain("HELIUS_RINGS_RPC_URL");
      expect(health.detail?.["rpc.reason"]).toContain("HELIUS_RINGS_PROVER_URL");
    });

    it("records the gateway's component statuses when reachable", async () => {
      const health = await service({
        gateway: gatewayStub({
          probeHealth: async () => ({
            rpc: "green",
            prover: "amber",
            photon: "green",
            gateway: "green",
          }),
        }),
      }).probeHealth();

      expect(health).toMatchObject({ rpc: "green", prover: "amber", gateway: "green" });
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
});

describe("computeIntentKey", () => {
  it("is deterministic and nonce-sensitive", () => {
    const base: PrivateOperationInput = {
      walletId: "hrw_1",
      opType: "shield",
      clientNonce: "n1",
    };

    expect(computeIntentKey(base)).toBe(computeIntentKey({ ...base }));
    expect(computeIntentKey(base)).not.toBe(computeIntentKey({ ...base, clientNonce: "n2" }));
    expect(computeIntentKey(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
