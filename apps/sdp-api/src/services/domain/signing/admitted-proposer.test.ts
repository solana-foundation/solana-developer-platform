import { generateKeyPairSync } from "node:crypto";
import type { CustodyProvisioningRuntime } from "@sdp/custody/provisioning/runtime";
import { runInClusterScope } from "@sdp/rpc/scope";
import { describe, expect, it, vi } from "vitest";
import type { MoneyAdmissionDecision } from "@/lib/money-admission";
import {
  admittedTransferProposer,
  type ProposalAccess,
  ProposalNotSentError,
  proposalReader,
  proposalRuntime,
} from "./admitted-proposer";

const SOURCE = "11111111111111111111111111111111";
const access: ProposalAccess = {
  apiKey: "tenant-key",
  // A real RSA key: the Fireblocks client signs a JWT before it sends anything.
  apiSecretPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
  apiBaseUrl: "https://fireblocks.example.test",
  vaultAccountId: "0",
  publicKey: SOURCE,
  connectionId: "cconn_1",
  accountFingerprint: "acct",
  assetId: "SOL_TEST",
};
const intent = {
  connectionId: "cconn_1",
  accountFingerprint: "acct",
  vaultAccountId: "0",
  assetId: "SOL_TEST",
};
const request = {
  externalId: "xfr_1",
  intent,
  sourceAddress: SOURCE,
  destination: "So11111111111111111111111111111111111111112",
  amount: "0.01",
  memo: "rent",
};
const context = {
  movement: "payments.transfer" as const,
  organizationId: "org_1",
  projectId: "prj_1",
  custodyWalletId: "cwlt_1",
  address: SOURCE,
};
const admitted: MoneyAdmissionDecision = { admitted: true };
const refused: MoneyAdmissionDecision = { admitted: false, reason: "movement_disabled" };

function runtime() {
  const fetch = vi.fn<CustodyProvisioningRuntime["fetch"]>(async (_url, init) =>
    Response.json(
      init?.method === "POST"
        ? { id: "fb-1", status: "SUBMITTED" }
        : { id: "fb-1", status: "PENDING_AUTHORIZATION", externalTxId: "xfr_1" }
    )
  );
  return {
    fetch,
    runtime: {
      ...proposalRuntime,
      fetch,
      sleep: async () => {},
    },
  };
}

const devnet = <T>(fn: () => Promise<T>) =>
  runInClusterScope({ projectId: "prj_1", environment: "sandbox" }, fn);

describe("admittedTransferProposer (PRO-2435 D2)", () => {
  it("refuses before any provider request when the waist's live decision refuses", async () => {
    const { fetch, runtime: rt } = runtime();
    const loadPropose = vi.fn(async () => access);
    const proposer = admittedTransferProposer(
      { prepare: async () => access, propose: loadPropose },
      async () => refused,
      context,
      rt
    );
    const error = await devnet(() => proposer.propose(request)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProposalNotSentError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses before any provider request when the live Connection no longer matches the intent", async () => {
    const { fetch, runtime: rt } = runtime();
    const proposer = admittedTransferProposer(
      {
        prepare: async () => access,
        propose: async () => ({ ...access, accountFingerprint: "another-account" }),
      },
      async () => admitted,
      context,
      rt
    );
    const error = await devnet(() => proposer.propose(request)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProposalNotSentError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("decides admission once per proposal and POSTs exactly once with the SDP id as externalTxId", async () => {
    const { fetch, runtime: rt } = runtime();
    const decide = vi.fn(async () => admitted);
    const loadPrepare = vi.fn(async () => access);
    const loadPropose = vi.fn(async () => access);
    const proposer = admittedTransferProposer(
      { prepare: loadPrepare, propose: loadPropose },
      decide,
      context,
      rt
    );
    await devnet(() => proposer.propose(request));
    expect(decide).toHaveBeenCalledTimes(1);
    // Proposing reads the credential fresh; nothing captured at prepare time is submitted.
    expect(loadPropose).toHaveBeenCalledTimes(1);
    expect(loadPrepare).not.toHaveBeenCalled();
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toMatchObject({
      operation: "TRANSFER",
      externalTxId: "xfr_1",
      source: { type: "VAULT_ACCOUNT", id: "0" },
      destination: { type: "ONE_TIME_ADDRESS" },
    });
  });

  it("prepares without deciding admission or sending anything", async () => {
    const { fetch, runtime: rt } = runtime();
    const decide = vi.fn(async () => admitted);
    const proposer = admittedTransferProposer(
      { prepare: async () => access, propose: async () => access },
      decide,
      context,
      rt
    );
    const prepared = await devnet(() =>
      proposer.prepare({ token: "SOL", amount: "0.01", native: true })
    );
    expect(decide).not.toHaveBeenCalled();
    // Native SOL needs no asset catalogue, so preparing makes no provider request at all.
    expect(fetch).not.toHaveBeenCalled();
    expect(prepared.intent).toEqual(intent);
  });

  it("gives recovery only a reader: it can GET a proposal but never create one", async () => {
    const { fetch, runtime: rt } = runtime();
    const reader = proposalReader(async () => access, rt);
    expect(Object.keys(reader)).toEqual(["read"]);
    const result = await reader.read("xfr_1");
    expect(result).toMatchObject({
      id: "fb-1",
      status: "PENDING_AUTHORIZATION",
      externalTxId: "xfr_1",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/v1/transactions/external_tx_id/xfr_1");
    expect(fetch.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
  });
});
