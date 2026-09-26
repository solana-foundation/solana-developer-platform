/**
 * @title Regression (APE-831 / SOLA9-652): metadata-update policy accounts for signer-paid SOL
 * @notice A deployed `PATCH /v1/issuance/tokens/:tokenId` metadata update is gated as
 * `issuance_metadata_update_execute`, but the executed Token-2022 metadata transaction
 * spends the custody signer's SOL for the network fee and any metadata-growth rent.
 * The policy candidate must therefore carry that native-SOL cost — as a SOL amount and
 * a fee-paying leg, using the fee-payer mode execution will use — so amount and
 * velocity rules for SOL govern the operation, and the route must fail closed when the
 * cost cannot be modeled. Generic operation-type deny/approval rules were never
 * affected; this file pins the quantitative SOL-accounting invariant.
 */

import { MosaicService } from "@sdp/issuance/mosaic/service";
import { evaluateCandidatePolicies } from "@sdp/policy";
import * as RpcModule from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import type { EffectiveWalletPolicy, PolicyRule, Token } from "@sdp/types";
import * as Kit from "@solana/kit";
import { type Address, generateKeyPairSigner, type TransactionSigner } from "@solana/kit";
import * as MosaicSdk from "@solana/mosaic-sdk";
import { parseTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import * as Token2022 from "@solana-program/token-2022";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { TokenService } from "@/services/token.service";
import { env as testEnv } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import type { updateTokenSchema } from "../schemas";
import { resolveAuthorityWallet } from "./authority-resolution";
import { extractTokenUpdatePolicyCandidate } from "./tokens";

vi.mock("@solana-program/token-2022", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana-program/token-2022")>()),
}));

vi.mock("@/routes/issuance/handlers/authority-resolution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/routes/issuance/handlers/authority-resolution")>()),
  resolveCurrentAuthorityForRole: vi
    .fn()
    .mockResolvedValue("Auth1111111111111111111111111111111111111"),
  resolveAuthorityWallet: vi.fn(),
  admitIssuanceRuntimeExecution: vi.fn().mockResolvedValue(undefined),
}));

type PrivateSubmit = {
  signAndSubmit(message: unknown): Promise<{ signature: string; slot: bigint }>;
};

/** Signer-paid execution mode: the test env ships a Kora url, this deployment must not. */
const signerPaidEnv: Env = (() => {
  const { KORA_RPC_URL: _kora, ...env } = testEnv;
  return env as Env;
})();

const NETWORK_FEE_LAMPORTS = 5_000n;
const RENT_EXEMPTION_MINIMUM = 1_000n;
const CURRENT_MINT_LAMPORTS = 100n;
const SIZE_INCREASING_NAME = "A longer metadata name that requires more rent";

function walletPolicy(rules: PolicyRule[]) {
  return {
    source: "customer_profile" as const,
    profile: null,
    revision: {
      id: "revision_metadata_policy",
      profileId: "profile_metadata_policy",
      revisionNumber: 1,
      rules,
      defaultAction: "allow" as const,
      commitMessage: null,
      createdBy: null,
      createdAt: "2026-09-25T00:00:00.000Z",
      activatedAt: "2026-09-25T00:00:00.000Z",
    },
    defaultAction: "allow" as const,
  } as EffectiveWalletPolicy;
}

function metadataToken(mint: string): Token {
  return {
    id: "tok_metadata_policy_regression",
    projectId: "prj_metadata_policy_regression",
    organizationId: "org_metadata_policy_regression",
    name: "Policy Token",
    symbol: "POLICY",
    decimals: 6,
    mintAddress: mint,
    mintAuthority: mint,
    metadataAuthority: mint,
    freezeAuthority: null,
    signingWalletId: "wal_metadata_policy_regression",
    signingCustodyWalletId: "cwlt_metadata_policy_regression",
    ablListAddress: null,
    description: null,
    uri: "https://example.com/old.json",
    imageUrl: null,
    template: "custom",
    totalSupply: "0",
    totalSupplyUpdatedAt: null,
    maxSupply: null,
    isMintable: true,
    isFreezable: false,
    requiresAllowlist: false,
    status: "active",
    deployedAt: "2026-09-25T00:00:00.000Z",
    createdBy: "key_metadata_policy_regression",
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  } as Token;
}

/**
 * Stub every on-chain read the metadata builder and the cost model share, plus
 * the network-fee pricing the cost model adds. `currentMintSizeBytes` drives
 * the growth decision (the builder targets `getMintSize` of the patched
 * metadata), and `feeLamports` stands in for getFeeForMessage pricing.
 */
function stubOnChainReads(params: {
  mint: Address;
  currentMintSizeBytes: number;
  targetMintSize: number;
  feeLamports?: bigint;
}) {
  const rpc = {
    getMinimumBalanceForRentExemption: () => ({
      send: async () => RENT_EXEMPTION_MINIMUM,
    }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: params.mint as unknown as string,
          lastValidBlockHeight: 100n,
        },
      }),
    }),
    getFeeForMessage: () => ({
      send: async () => ({ value: params.feeLamports ?? NETWORK_FEE_LAMPORTS }),
    }),
  };
  vi.spyOn(RpcModule, "createRpcForSdk").mockReturnValue(rpc as never);
  vi.spyOn(Kit, "fetchEncodedAccount").mockResolvedValue({
    exists: true,
    address: params.mint,
    lamports: CURRENT_MINT_LAMPORTS,
    data: new Uint8Array(params.currentMintSizeBytes),
  } as never);
  vi.spyOn(Token2022, "decodeMint").mockReturnValue({
    data: {
      extensions: {
        __option: "Some",
        value: [
          {
            __kind: "TokenMetadata",
            name: "Old",
            uri: "https://example.com/old.json",
            additionalMetadata: new Map(),
          },
        ],
      },
    },
  } as never);
  vi.spyOn(Token2022, "getMintSize").mockReturnValue(params.targetMintSize);
  vi.spyOn(MosaicSdk, "getTokenMetadata").mockResolvedValue({
    name: "Old",
    uri: "https://example.com/old.json",
    additionalMetadata: new Map(),
  } as never);
}

/**
 * Run the REAL metadata builder the handler executes and capture the compiled
 * transaction message it would sign and submit, so the candidate's modeled SOL
 * accounting is asserted against the generated instructions.
 */
async function captureExecutedMetadataTransaction(params: {
  mint: Address;
  signer: TransactionSigner;
  name: string;
}): Promise<{
  instructions: readonly { programAddress: string; data: Uint8Array }[];
}> {
  let submitted: {
    instructions: readonly { programAddress: string; data: Uint8Array }[];
  } | null = null;
  vi.spyOn(MosaicService.prototype as unknown as PrivateSubmit, "signAndSubmit").mockImplementation(
    async (message) => {
      submitted = message as typeof submitted;
      return { signature: "regression-signature", slot: 1n };
    }
  );

  const service = new MosaicService(
    signerPaidEnv as unknown as ConstructorParameters<typeof MosaicService>[0],
    params.signer
  );
  await service.updateMetadata({
    mint: params.mint,
    name: params.name,
    updateAuthority: params.signer,
    feePayer: params.signer,
  });

  if (submitted === null) {
    throw new Error("expected the metadata update to build a transaction");
  }
  return submitted;
}

function metadataRequestContext(params: {
  token: Token;
  body: Record<string, unknown>;
  env: Env;
}): ValidatedBodyContext<typeof updateTokenSchema> {
  const store = new Map<string, unknown>([
    [
      "apiKey",
      {
        id: "key_metadata_policy_regression",
        organizationId: params.token.organizationId,
        projectId: params.token.projectId,
        role: "api_developer",
        permissions: ["tokens:write"],
        environment: "sandbox",
        walletScope: "all",
        signingWalletId: null,
        signingWalletIds: [],
        walletBindings: [],
      },
    ],
    ["projectId", params.token.projectId],
  ]);
  return {
    env: params.env,
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
    req: {
      param: () => ({ tokenId: params.token.id }),
      valid: () => params.body,
    },
  } as unknown as ValidatedBodyContext<typeof updateTokenSchema>;
}

async function extractMetadataUpdateCandidate(params: {
  token: Token;
  signer: TransactionSigner;
  body?: Record<string, unknown>;
  env?: Env;
}) {
  const resolver = vi.mocked(resolveAuthorityWallet);
  resolver.mockResolvedValue({
    custodyWalletId: params.token.signingCustodyWalletId as string,
    providerWalletId: params.token.signingWalletId as string,
    publicKey: params.signer.address,
  });
  vi.spyOn(TokenService.prototype, "getToken").mockResolvedValue(params.token);

  return extractTokenUpdatePolicyCandidate(
    metadataRequestContext({
      token: params.token,
      body: params.body ?? { name: SIZE_INCREASING_NAME },
      env: params.env ?? signerPaidEnv,
    })
  );
}

describe("extractTokenUpdatePolicyCandidate — metadata SOL accounting (APE-831)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("models signer-paid fee plus metadata-growth rent as SOL on the candidate and matches the executed instructions", async () => {
    const signer = await generateKeyPairSigner();
    const mint = (await generateKeyPairSigner()).address;
    const token = metadataToken(mint);
    // Mint grows 100 → 200 bytes: rent = 1000 (exemption minimum) - 100 (current) = 900.
    stubOnChainReads({
      mint,
      currentMintSizeBytes: 100,
      targetMintSize: 200,
    });

    const extraction = await extractMetadataUpdateCandidate({
      token,
      signer,
      body: { name: SIZE_INCREASING_NAME },
    });
    const candidate = extraction.candidate;
    expect(candidate).not.toBeNull();

    // The operation spends native SOL from the custody signer, not the token.
    expect(candidate?.asset).toBe("SOL");
    expect(candidate?.amount).toBe(formatDecimalAmount(NETWORK_FEE_LAMPORTS + 900n, 9));

    // The fee-paying movement is represented as a leg.
    expect(extraction.legs).toHaveLength(1);
    expect(extraction.legs[0]).toMatchObject({
      asset: "SOL",
      amount: formatDecimalAmount(NETWORK_FEE_LAMPORTS + 900n, 9),
      custodyWalletId: token.signingCustodyWalletId,
    });
    expect(candidate?.context.metadataUpdateFeePayer).toBe("custody_signer");

    // ...and the accounting matches the instructions execution generates.
    const submitted = await captureExecutedMetadataTransaction({
      mint,
      signer,
      name: SIZE_INCREASING_NAME,
    });
    expect(submitted.instructions[0]?.programAddress).toBe(SYSTEM_PROGRAM_ADDRESS);
    const rentTransfer = parseTransferSolInstruction(submitted.instructions[0] as never);
    expect(rentTransfer.data.amount).toBe(900n);
    expect(rentTransfer.accounts.source.address).toBe(signer.address);
    expect(rentTransfer.accounts.destination.address).toBe(mint);
    expect(submitted.instructions[1]?.programAddress).toBe(Token2022.TOKEN_2022_PROGRAM_ADDRESS);
    expect(candidate?.amount).toBe(
      formatDecimalAmount(NETWORK_FEE_LAMPORTS + rentTransfer.data.amount, 9)
    );
  });

  it("models an unchanged-size update as the network fee alone, with no rent transfer in the instructions", async () => {
    const signer = await generateKeyPairSigner();
    const mint = (await generateKeyPairSigner()).address;
    const token = metadataToken(mint);
    // Same size on-chain and after the patch: no realloc, no rent transfer.
    stubOnChainReads({
      mint,
      currentMintSizeBytes: 200,
      targetMintSize: 200,
    });

    const extraction = await extractMetadataUpdateCandidate({
      token,
      signer,
      body: { name: SIZE_INCREASING_NAME },
    });
    expect(extraction.candidate?.asset).toBe("SOL");
    expect(extraction.candidate?.amount).toBe(formatDecimalAmount(NETWORK_FEE_LAMPORTS, 9));
    expect(extraction.legs[0]).toMatchObject({
      asset: "SOL",
      amount: formatDecimalAmount(NETWORK_FEE_LAMPORTS, 9),
    });

    const submitted = await captureExecutedMetadataTransaction({
      mint,
      signer,
      name: SIZE_INCREASING_NAME,
    });
    expect(submitted.instructions[0]?.programAddress).toBe(Token2022.TOKEN_2022_PROGRAM_ADDRESS);
  });

  it("fails closed when the SOL cost cannot be modeled", async () => {
    const signer = await generateKeyPairSigner();
    const mint = (await generateKeyPairSigner()).address;
    const token = metadataToken(mint);
    stubOnChainReads({ mint, currentMintSizeBytes: 100, targetMintSize: 200 });
    vi.spyOn(Kit, "fetchEncodedAccount").mockRejectedValue(new Error("rpc unavailable"));

    await expect(extractMetadataUpdateCandidate({ token, signer })).rejects.toThrow();
  });

  it("models a sponsored update as zero custody SOL, matching the sponsor fee payer execution uses", async () => {
    const signer = await generateKeyPairSigner();
    const mint = (await generateKeyPairSigner()).address;
    const token = metadataToken(mint);
    stubOnChainReads({ mint, currentMintSizeBytes: 100, targetMintSize: 200 });
    const createRpcSpy = vi.spyOn(RpcModule, "createRpcForSdk");

    const extraction = await extractMetadataUpdateCandidate({
      token,
      signer,
      env: testEnv as Env,
    });
    expect(extraction.candidate?.asset).toBe("SOL");
    expect(extraction.candidate?.amount).toBe("0");
    expect(extraction.candidate?.context.metadataUpdateFeePayer).toBe("sponsor");
    // No custody-SOL model needs an RPC round trip when the sponsor pays.
    expect(createRpcSpy).not.toHaveBeenCalled();
  });

  it("models a patch that changes nothing on-chain as zero custody SOL", async () => {
    const signer = await generateKeyPairSigner();
    const mint = (await generateKeyPairSigner()).address;
    const token = metadataToken(mint);
    stubOnChainReads({ mint, currentMintSizeBytes: 200, targetMintSize: 200 });
    // The requested name equals the on-chain name: the builder submits nothing.
    vi.spyOn(MosaicSdk, "getTokenMetadata").mockResolvedValue({
      name: "Old",
      uri: "https://example.com/old.json",
      additionalMetadata: new Map(),
    } as never);

    const extraction = await extractMetadataUpdateCandidate({
      token,
      signer,
      body: { name: "Old" },
    });
    expect(extraction.candidate?.asset).toBe("SOL");
    expect(extraction.candidate?.amount).toBe("0");
    expect(extraction.candidate?.context.metadataUpdateFeePayer).toBe("custody_signer");
    expect(extraction.legs[0]?.amount).toBe("0");
  });

  it("lets quantitative SOL policy deny a metadata update, while generic operation rules keep working", async () => {
    const signer = await generateKeyPairSigner();
    const mint = (await generateKeyPairSigner()).address;
    const token = metadataToken(mint);
    stubOnChainReads({ mint, currentMintSizeBytes: 100, targetMintSize: 200 });

    const extraction = await extractMetadataUpdateCandidate({ token, signer });
    const candidate = extraction.candidate;
    if (!candidate) {
      throw new Error("expected the metadata update to produce a policy candidate");
    }

    // The reported exploit: zero-SOL quantitative controls abstained on a null
    // amount. With the cost modeled as SOL they must deny.
    const evaluation = evaluateCandidatePolicies({
      candidate,
      legs: extraction.legs,
      walletPolicy: walletPolicy([
        { id: "sol-amount-zero", kind: "amount", asset: "SOL", max: "0", action: "deny" },
        {
          id: "sol-velocity-zero",
          kind: "velocity",
          asset: "SOL",
          window: "P1D",
          max: "0",
          action: "deny",
        },
      ]),
      apiKeyPolicy: null,
      velocity: {
        lookup: () => ({
          scope: "wallet",
          window: "P1D",
          asset: "SOL",
          operationTypes: ["issuance_metadata_update_execute"],
          total: "0",
        }),
      },
    });
    expect(evaluation.decision).toBe("deny");

    // Velocity accounting: the modeled outflow projects into the window total.
    const velocityEvaluation = evaluateCandidatePolicies({
      candidate,
      legs: extraction.legs,
      walletPolicy: walletPolicy([
        {
          id: "sol-velocity",
          kind: "velocity",
          asset: "SOL",
          window: "P1D",
          max: "0.000005",
          action: "deny",
        },
      ]),
      apiKeyPolicy: null,
      velocity: {
        lookup: () => ({
          scope: "wallet",
          window: "P1D",
          asset: "SOL",
          operationTypes: ["issuance_metadata_update_execute"],
          total: "0.000005",
        }),
      },
    });
    expect(velocityEvaluation.decision).toBe("deny");

    // Operations without quantitative limits keep working: a within-bounds
    // amount rule matches and allows.
    const allowEvaluation = evaluateCandidatePolicies({
      candidate,
      legs: extraction.legs,
      walletPolicy: walletPolicy([
        { id: "sol-amount-cap", kind: "amount", asset: "SOL", max: "0.001" },
      ]),
      apiKeyPolicy: null,
      velocity: {
        lookup: () => ({
          scope: "wallet",
          window: "P1D",
          asset: "SOL",
          operationTypes: ["issuance_metadata_update_execute"],
          total: "0",
        }),
      },
    });
    expect(allowEvaluation.decision).toBe("allow");

    // Generic operation-type deny/approval rules were never affected.
    const genericDeny = evaluateCandidatePolicies({
      candidate,
      legs: extraction.legs,
      walletPolicy: walletPolicy([
        {
          id: "deny-metadata-operation",
          kind: "operation_type",
          operationTypes: ["issuance_metadata_update_execute"],
          action: "deny",
        },
      ]),
      apiKeyPolicy: null,
    });
    expect(genericDeny.decision).toBe("deny");

    // Destination rules keep deciding on the fee-paying leg's null destination
    // exactly as they decided on the destination-less candidate before: an
    // allowlist denies, a blocklist abstains.
    const allowlistDeny = evaluateCandidatePolicies({
      candidate,
      legs: extraction.legs,
      walletPolicy: walletPolicy([
        {
          id: "destination-allowlist",
          kind: "destination",
          allowlist: ["Dest1111111111111111111111111111111111111"],
        },
      ]),
      apiKeyPolicy: null,
    });
    expect(allowlistDeny.decision).toBe("deny");

    const blocklistAbstains = evaluateCandidatePolicies({
      candidate,
      legs: extraction.legs,
      walletPolicy: walletPolicy([
        {
          id: "destination-blocklist",
          kind: "destination",
          blocklist: ["Blocked11111111111111111111111111111111111"],
        },
      ]),
      apiKeyPolicy: null,
    });
    expect(blocklistAbstains.decision).toBe("allow");
  });
});
