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
  proposalRecovery,
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

describe("proposalRecovery (PRO-2435 D4)", () => {
  const detail = {
    id: "provider-transaction",
    externalTxId: request.externalId,
    status: "PENDING_SIGNATURE",
    operation: "TRANSFER",
    assetId: intent.assetId,
    source: { type: "VAULT_ACCOUNT", id: intent.vaultAccountId },
  };

  function recoveryRuntime(patch: Record<string, unknown> = {}) {
    const fetch = vi.fn<CustodyProvisioningRuntime["fetch"]>(async (_url, init) =>
      Response.json(init?.method === "POST" ? { success: true } : { ...detail, ...patch })
    );
    return { fetch, runtime: { ...proposalRuntime, fetch } };
  }

  it("separates admission from read and cancellation without exposing a submission method", async () => {
    const { fetch, runtime: rt } = recoveryRuntime();
    const admit = vi.fn(async () => {});
    const loadAccess = vi.fn(async () => access);
    const recovery = proposalRecovery(loadAccess, intent, admit, rt);
    expect(Object.keys(recovery).sort()).toEqual(["admit", "cancel", "read"]);
    expect(admit).not.toHaveBeenCalled();
    expect(loadAccess).not.toHaveBeenCalled();
    await recovery.admit();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(loadAccess).not.toHaveBeenCalled();
    await recovery.read(request.externalId);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("resolves and verifies the external id before cancelling with retained tenant credentials", async () => {
    const { fetch, runtime: rt } = recoveryRuntime();
    const admit = vi.fn(async () => {
      throw new Error("principal revoked");
    });
    const recovery = proposalRecovery(async () => access, intent, admit, rt);
    await expect(recovery.admit()).rejects.toThrow("principal revoked");
    await expect(recovery.cancel(request.externalId)).resolves.toBe(true);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${access.apiBaseUrl}/v1/transactions/external_tx_id/${request.externalId}`, "GET"],
      [`${access.apiBaseUrl}/v1/transactions/${detail.id}/cancel`, "POST"],
    ]);
    for (const [, init] of fetch.mock.calls)
      expect(new Headers(init?.headers).get("X-API-Key")).toBe(access.apiKey);
  });

  it("reloads account-bound access after the worker read before a cancellation mutation", async () => {
    const { fetch, runtime: rt } = recoveryRuntime();
    const loadAccess = vi
      .fn(async () => access)
      .mockResolvedValueOnce(access)
      .mockRejectedValueOnce(new Error("Fireblocks connection binding changed"));
    const recovery = proposalRecovery(loadAccess, intent, async () => {}, rt);
    await recovery.read(request.externalId);
    await expect(recovery.cancel(request.externalId)).rejects.toThrow("binding changed");
    expect(loadAccess).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("rechecks provider progress across the durable claim before cancelling", async () => {
    const fetch = vi
      .fn<CustodyProvisioningRuntime["fetch"]>()
      .mockResolvedValueOnce(Response.json(detail))
      .mockResolvedValueOnce(Response.json({ ...detail, status: "COMPLETED" }));
    const loadAccess = vi.fn(async () => access);
    const recovery = proposalRecovery(loadAccess, intent, async () => {}, {
      ...proposalRuntime,
      fetch,
    });
    expect((await recovery.read(request.externalId))?.status).toBe("PENDING_SIGNATURE");
    await expect(recovery.cancel(request.externalId)).resolves.toBe(false);
    expect(loadAccess).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
  });

  it.each([
    { externalTxId: "another-payment" },
    { operation: "RAW" },
    { assetId: "another-asset" },
    { source: { type: "EXCHANGE_ACCOUNT", id: intent.vaultAccountId } },
    { source: { type: "VAULT_ACCOUNT", id: "another-vault" } },
    { source: null },
  ])(
    "never cancels transaction detail that conflicts with its recorded intent: %j",
    async (patch) => {
      const { fetch, runtime: rt } = recoveryRuntime(patch);
      const recovery = proposalRecovery(
        async () => access,
        intent,
        async () => {},
        rt
      );
      await expect(recovery.cancel(request.externalId)).rejects.toThrow(
        "does not match the payment intent"
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
    }
  );

  it.each(["BROADCASTING", "CONFIRMING", "COMPLETED", "CANCELLING", "CANCELLED", "NEW_STATE"])(
    "observes %s without a cancellation POST",
    async (status) => {
      const { fetch, runtime: rt } = recoveryRuntime({ status });
      const recovery = proposalRecovery(
        async () => access,
        intent,
        async () => {},
        rt
      );
      await expect(recovery.cancel(request.externalId)).resolves.toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it("re-reads the bound transaction before retrying a negative cancellation acknowledgment", async () => {
    let cancellationAttempts = 0;
    const fetch = vi.fn<CustodyProvisioningRuntime["fetch"]>(async (_url, init) => {
      if (init?.method !== "POST") return Response.json(detail);
      cancellationAttempts += 1;
      return Response.json({ success: cancellationAttempts > 1 });
    });
    const recovery = proposalRecovery(
      async () => access,
      intent,
      async () => {},
      {
        ...proposalRuntime,
        fetch,
      }
    );
    await expect(recovery.cancel(request.externalId)).resolves.toBe(false);
    await expect(recovery.cancel(request.externalId)).resolves.toBe(true);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
    ]);
  });

  it("does not cancel an external id missing from the provider", async () => {
    const fetch = vi.fn<CustodyProvisioningRuntime["fetch"]>(async () =>
      Response.json({}, { status: 404 })
    );
    const recovery = proposalRecovery(
      async () => access,
      intent,
      async () => {},
      {
        ...proposalRuntime,
        fetch,
      }
    );
    await expect(recovery.cancel(request.externalId)).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("propagates an ambiguous cancellation failure without retrying or claiming a terminal result", async () => {
    const fetch = vi.fn<CustodyProvisioningRuntime["fetch"]>(async (_url, init) => {
      if (init?.method === "POST") throw new Error("connection lost after acceptance");
      return Response.json(detail);
    });
    const recovery = proposalRecovery(
      async () => access,
      intent,
      async () => {},
      {
        ...proposalRuntime,
        fetch,
      }
    );
    await expect(recovery.cancel(request.externalId)).rejects.toThrow(
      "connection lost after acceptance"
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
