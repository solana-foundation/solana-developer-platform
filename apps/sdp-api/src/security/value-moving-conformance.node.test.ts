import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const boundaryMocks = vi.hoisted(() => ({
  createOrgSigner: vi.fn(),
  createSponsorship: vi.fn(),
  enforcePolicy: vi.fn(),
  resolvePolicyWallet: vi.fn(),
}));

vi.mock("@/services/solana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/solana")>()),
  createOrgSigner: boundaryMocks.createOrgSigner,
}));

vi.mock("@/services/sponsorship.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sponsorship.service")>()),
  createAuthenticatedSponsorshipFeePayment: boundaryMocks.createSponsorship,
}));

vi.mock("@/services/policy/enforcement.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/policy/enforcement.service")>()),
  enforceWalletOperationPolicy: boundaryMocks.enforcePolicy,
  resolvePolicyCustodyWallet: boundaryMocks.resolvePolicyWallet,
}));

import { signerCheck } from "@/routes/custody/handlers/signer-check";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");

type ValueMovingFamily =
  | "batch"
  | "recurring"
  | "issuance"
  | "payments"
  | "ramps"
  | "custody"
  | "raw_signing";

interface OrderedBoundary {
  file: string;
  section: string;
  before: string;
  after: string;
}

interface ReplayEvidence {
  mode:
    | "idempotency_fingerprint"
    | "claimed_state_machine"
    | "provider_signature_window"
    | "fresh_blockhash_per_attempt";
  file: string;
  evidence: string;
}

interface ValueMovingContract {
  family: ValueMovingFamily;
  trustedContext: { file: string; evidence: string };
  authorization: OrderedBoundary;
  replay: ReplayEvidence[];
}

const contracts: ValueMovingContract[] = [
  {
    family: "batch",
    trustedContext: {
      file: "apps/sdp-api/src/routes/payments/handlers/transfer-batches/create.ts",
      evidence: "resolved.scope.auth.organizationId",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/payments/handlers/transfer-batches/create.ts",
      section: "export async function createTransferBatch",
      before: "await enforceBatchPolicies(c, resolved, parsed.data)",
      after: "solanaServices.createOrgSigner(",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/payments/transfer-batches.test.ts",
        evidence: "replays the original transfer batch for the same idempotency key and payload",
      },
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/payments/transfer-batches.test.ts",
        evidence: "returns the original batch when a concurrent insert loses the idempotency race",
      },
    ],
  },
  {
    family: "recurring",
    trustedContext: {
      file: "apps/sdp-api/src/services/payments/recurring-payments/shared.ts",
      evidence: "createProjectSponsorshipFeePayment(input.env",
    },
    authorization: {
      file: "apps/sdp-api/src/services/payments/recurring-payments/activation.ts",
      section: "export async function activateRecurringPayment",
      before: "claimRecurringPaymentActivation({",
      after: "solanaServices.createOrgSigner(",
    },
    replay: [
      {
        mode: "claimed_state_machine",
        file: "apps/sdp-api/src/routes/payments.test.ts",
        evidence:
          "recovers stale authorized recurring payments without re-confirming old signatures",
      },
      {
        mode: "fresh_blockhash_per_attempt",
        file: "apps/sdp-api/src/routes/payments.test.ts",
        evidence: "journals failed on-chain activation attempts and retries with a fresh signature",
      },
    ],
  },
  {
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/policy.ts",
      evidence: "getRequestTenantScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/handlers/authority.ts",
      section: "export const executeUpdateAuthority",
      before: "await enforceIssuanceWalletOperationPolicy(c",
      after: "createResolvedAuthoritySigner({",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "without poisoning the idempotency slot",
      },
    ],
  },
  {
    family: "payments",
    trustedContext: {
      file: "apps/sdp-api/src/routes/payments/context.ts",
      evidence: "createRequestSponsorshipFeePayment(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/payments/handlers/transfers.ts",
      section: "export async function createTransfer",
      before: "await enforcePaymentTransferOperationPolicy(c, scope, operation",
      after: "await executeSolTransfer(",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/payments.test.ts",
        evidence: "replays a transfer when the same Idempotency-Key + body is retried",
      },
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/payments.test.ts",
        evidence: "rejects the same Idempotency-Key with a different body",
      },
    ],
  },
  {
    family: "ramps",
    trustedContext: {
      file: "apps/sdp-api/src/routes/payments/handlers/ramps.ts",
      evidence: "getRequestTenantScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/payments/handlers/ramps.ts",
      section: "export async function createOnrampQuote",
      before: "await enforceRampWalletOperationPolicy(c",
      after: "RAMP_PROVIDER_CLIENTS.moonpay.createOnrampQuote",
    },
    replay: [
      {
        mode: "provider_signature_window",
        file: "apps/sdp-api/src/routes/webhooks/ramps/stripe.test.ts",
        evidence: "accepts a correctly signed webhook and rejects a forged one",
      },
      {
        mode: "provider_signature_window",
        file: "apps/sdp-api/src/routes/webhooks/ramps/stripe.test.ts",
        evidence: "rejects a correctly signed but stale webhook",
      },
    ],
  },
  {
    family: "custody",
    trustedContext: {
      file: "apps/sdp-api/src/routes/private-channels/transfer-access.ts",
      evidence: "const scope = { organizationId: auth.organizationId, projectId }",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/private-channels/transfer-access.ts",
      section: "export async function resolveTransferCreateContext",
      before: "if (!verifiedSource)",
      after: "signer = await createOrgSigner(",
    },
    replay: [
      {
        mode: "fresh_blockhash_per_attempt",
        file: "apps/sdp-api/src/services/private-channels/transfer.node.test.ts",
        evidence: "fetches the blockhash and sends within one gateway unit",
      },
      {
        mode: "claimed_state_machine",
        file: "apps/sdp-api/src/services/private-channels/transfer.node.test.ts",
        evidence: "allows a later retry",
      },
    ],
  },
  {
    family: "raw_signing",
    trustedContext: {
      file: "apps/sdp-api/src/routes/custody/handlers/signer-check.ts",
      evidence: "getRequestTenantScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/custody/handlers/signer-check.ts",
      section: "export const signerCheck",
      before: "await enforceWalletOperationPolicy(c.env",
      after: "const signer = await createOrgSigner(",
    },
    replay: [
      {
        mode: "fresh_blockhash_per_attempt",
        file: "apps/sdp-api/src/routes/custody/handlers/signer-check.ts",
        evidence: 'getRecentBlockhash(rpc, "confirmed")',
      },
    ],
  },
];

const signingSinkInventory: Record<string, string[]> = {
  "apps/sdp-api/src/routes/custody/handlers/signer-check.ts": ["signAndSend"],
  "apps/sdp-api/src/routes/pay.ts": ["signAsFeePayer"],
  "apps/sdp-api/src/routes/payments/handlers/transfer-batches/execute.ts": ["signAndSend"],
  "apps/sdp-api/src/routes/payments/handlers/transfers.ts": [
    "signAndSend",
    "signAndSend",
    "signAndSend",
  ],
  "apps/sdp-api/src/services/payments/recurring-payments/shared.ts": ["signAndSend"],
  "apps/sdp-api/src/services/private-channels/deposit.ts": ["signTransactionMessageWithSigners"],
  "apps/sdp-api/src/services/private-channels/transfer.ts": ["signTransactionMessageWithSigners"],
  "apps/sdp-api/src/services/private-channels/withdraw.ts": ["signTransactionMessageWithSigners"],
  "packages/sdp-issuance/src/mosaic/service.ts": [
    "signAndSend",
    "signTransactionMessageWithSigners",
  ],
  "packages/sdp-solana/src/token-2022.ts": ["signAndSend", "signTransactionMessageWithSigners"],
};

const valueMovingSourceRoots = [
  "apps/sdp-api/src/routes",
  "apps/sdp-api/src/services/payments",
  "apps/sdp-api/src/services/private-channels",
  "packages/sdp-issuance/src",
  "packages/sdp-solana/src",
];

function readSource(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(entryPath);
    }
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".spec.ts")
    ) {
      return [];
    }
    return [entryPath];
  });
}

function discoverSigningSinks(): Record<string, string[]> {
  const sinkPattern = /\.(signAndSend|signAsFeePayer)\(|\b(signTransactionMessageWithSigners)\(/g;
  const inventory: Record<string, string[]> = {};

  for (const root of valueMovingSourceRoots) {
    for (const file of sourceFiles(path.join(repositoryRoot, root))) {
      const sinks = [...readFileSync(file, "utf8").matchAll(sinkPattern)].map(
        (match) => match[1] ?? match[2]
      );
      if (sinks.length > 0) {
        inventory[path.relative(repositoryRoot, file)] = sinks;
      }
    }
  }

  return inventory;
}

function sectionSource(boundary: OrderedBoundary): string {
  const source = readSource(boundary.file);
  const start = source.indexOf(boundary.section);
  expect(start, `${boundary.file} must retain section ${boundary.section}`).toBeGreaterThanOrEqual(
    0
  );
  return source.slice(start);
}

describe("value-moving authorization and replay conformance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundaryMocks.resolvePolicyWallet.mockResolvedValue({ id: "cwlt_authorized" });
  });

  it("covers every required value-moving family", () => {
    expect(contracts.map((contract) => contract.family).sort()).toEqual([
      "batch",
      "custody",
      "issuance",
      "payments",
      "ramps",
      "raw_signing",
      "recurring",
    ]);
  });

  it.each(contracts)("authorizes $family from trusted context before signing", (contract) => {
    expect(readSource(contract.trustedContext.file)).toContain(contract.trustedContext.evidence);

    const source = sectionSource(contract.authorization);
    const authorizationIndex = source.indexOf(contract.authorization.before);
    const signerIndex = source.indexOf(contract.authorization.after);
    expect(authorizationIndex, `${contract.family} authorization marker`).toBeGreaterThanOrEqual(0);
    expect(signerIndex, `${contract.family} signing marker`).toBeGreaterThanOrEqual(0);
    expect(authorizationIndex).toBeLessThan(signerIndex);
  });

  it.each(contracts)("keeps explicit replay evidence for $family", (contract) => {
    expect(contract.replay.length).toBeGreaterThan(0);
    for (const replay of contract.replay) {
      expect(readSource(replay.file), `${contract.family}: ${replay.mode}`).toContain(
        replay.evidence
      );
    }
  });

  it("catalogs every production signing sink", () => {
    expect(discoverSigningSinks()).toEqual(signingSinkInventory);
  });

  it("keeps durable nonce lifetimes disabled", () => {
    const productionSource = valueMovingSourceRoots
      .flatMap((root) => sourceFiles(path.join(repositoryRoot, root)))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(productionSource).not.toMatch(
      /durable.?nonce|nonce.?account|advance.?nonce|setTransactionMessageLifetimeUsingDurableNonce/i
    );
  });

  it("stops a raw-sign policy denial before signer, KMS, or Kora access", async () => {
    boundaryMocks.enforcePolicy.mockRejectedValueOnce(
      new AppError("FORBIDDEN", "Denied by wallet policy")
    );
    const apiKey = {
      id: "key_conformance",
      organizationId: "org_conformance",
      projectId: "prj_conformance",
      role: "admin",
      permissions: ["wallets:write"],
      environment: "sandbox",
      signingWalletId: "wal_conformance",
      signingWalletIds: ["wal_conformance"],
      walletBindings: [{ walletId: "wal_conformance", permissions: ["wallets:write"] }],
    };
    const context = {
      env: {},
      req: {
        json: vi.fn().mockResolvedValue({ walletId: "wal_conformance", memo: "conformance" }),
      },
      get: vi.fn((key: string) => {
        if (key === "apiKey") return apiKey;
        if (key === "projectId") return "prj_conformance";
        if (key === "projectEnvironment") return "sandbox";
        return undefined;
      }),
    } as never;

    await expect(signerCheck(context)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(boundaryMocks.createOrgSigner).not.toHaveBeenCalled();
    expect(boundaryMocks.createSponsorship).not.toHaveBeenCalled();
  });
});
