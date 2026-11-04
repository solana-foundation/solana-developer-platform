import { beforeEach, describe, expect, it, vi } from "vitest";
import { SdpApiResponseError } from "@/lib/sdp-api";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "user_test", orgId: "org_test" })),
}));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createSdpApiClient: mocks.createSdpApiClient,
}));

import {
  createCustodySetupWalletAction,
  initializeCustodySetupAction,
  requestDevnetSolanaFaucetAction,
} from "./actions";

beforeEach(() => setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/wallet_one`));

function walletForm(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

function requestBody(client: { fetch: ReturnType<typeof vi.fn> }): Record<string, unknown> {
  return JSON.parse(String(client.fetch.mock.calls[0]?.[1]?.body));
}

describe("initializeCustodySetupAction", () => {
  const client = { fetch: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSdpApiClient.mockResolvedValue(client);
  });

  // The key's original request never recorded its outcome: the wallet may
  // exist, so the user is told to check the list, not that the provider is set up.
  it("tells the user to check the list after an unknown outcome", async () => {
    client.fetch.mockRejectedValue(
      new SdpApiResponseError(
        409,
        JSON.stringify({ error: { code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN", message: "GET it" } })
      )
    );

    const result = await initializeCustodySetupAction(
      walletForm({ provider: "privy", walletLabel: "Treasury" })
    );

    expect(result).toEqual({
      status: "error",
      message: "Shared.idempotency.outcomeUnknownCheckList",
      answer: { status: 409, replayed: false, code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN" },
    });
  });

  // Greptile (#2333): the first setup still running answered the retry with a
  // 409 that read as "already set up", so the user was sent to add a wallet.
  it("reports a setup still in flight as a retryable error, not as set up", async () => {
    client.fetch.mockRejectedValue(
      new SdpApiResponseError(
        409,
        JSON.stringify({ error: { code: "IDEMPOTENCY_KEY_IN_FLIGHT", message: "In progress" } })
      )
    );

    const result = await initializeCustodySetupAction(
      walletForm({ provider: "privy", walletLabel: "Treasury" })
    );

    expect(result).toMatchObject({
      status: "error",
      answer: { status: 409, replayed: false, code: "IDEMPOTENCY_KEY_IN_FLIGHT" },
    });
  });

  it("reports an already set up provider and makes no other API call", async () => {
    client.fetch.mockRejectedValue(
      new Error('SDP API request failed (409): {"error":{"message":"Signing already initialized"}}')
    );

    const result = await initializeCustodySetupAction(
      walletForm({ provider: "privy", walletLabel: "Treasury" })
    );

    expect(result).toEqual({
      status: "provider_already_set_up",
      answer: { status: 409, replayed: false, code: null },
    });
    expect(client.fetch).toHaveBeenCalledExactlyOnceWith(
      "/v1/wallets/initialize",
      expect.anything()
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("createCustodySetupWalletAction", () => {
  const client = { fetch: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    client.fetch.mockResolvedValue({});
    mocks.createSdpApiClient.mockResolvedValue(client);
  });

  it("creates the wallet in the chosen connection", async () => {
    const result = await createCustodySetupWalletAction(
      walletForm({ provider: "privy", label: "Treasury", connectionId: "conn_eu" })
    );

    expect(result).toEqual({ status: "success" });
    expect(client.fetch).toHaveBeenCalledWith("/v1/wallets", expect.anything());
    expect(requestBody(client)).toEqual({ connectionId: "conn_eu", label: "Treasury" });
  });

  // HOO-1918: the browser mints the key per user action; the server forwards it
  // and never mints one, so a retried action is the same request upstream.
  it("forwards the browser's Idempotency-Key and keeps it out of the body", async () => {
    await createCustodySetupWalletAction(
      walletForm({ provider: "privy", label: "Treasury", idempotencyKey: "browser-key" })
    );

    expect(client.fetch.mock.calls[0]?.[1]?.headers).toEqual({ "Idempotency-Key": "browser-key" });
    expect(requestBody(client)).not.toHaveProperty("idempotencyKey");
  });

  // The browser cannot see the status or Idempotent-Replayed through a server
  // action, so the action reports what sdp-api answered for the key it forwarded.
  it.each([
    ["a replayed stored failure", new SdpApiResponseError(422, "{}", true), 422, true],
    ["a fresh refusal", new SdpApiResponseError(422, "{}"), 422, false],
    ["a conflict", new SdpApiResponseError(409, "{}"), 409, false],
    ["a server error", new SdpApiResponseError(502, "{}"), 502, false],
    ["a transport failure", new TypeError("fetch failed"), null, false],
  ] as const)("reports %s to the browser", async (_name, error, status, replayed) => {
    client.fetch.mockRejectedValue(error);

    const result = await createCustodySetupWalletAction(
      walletForm({ provider: "privy", idempotencyKey: "browser-key" })
    );

    expect(result).toMatchObject({ status: "error", answer: { status, replayed } });
  });

  // Sending both would leave the API to reconcile a connection against a
  // provider that may own several of them.
  it("drops the provider once a connection names the credential", async () => {
    await createCustodySetupWalletAction(
      walletForm({ provider: "privy", label: "Treasury", connectionId: "conn_eu" })
    );

    expect(requestBody(client)).not.toHaveProperty("provider");
  });

  it("names the provider's Managed config when no connection is chosen", async () => {
    await createCustodySetupWalletAction(walletForm({ provider: "privy", label: "Treasury" }));

    expect(requestBody(client)).toEqual({ provider: "privy", label: "Treasury" });
  });

  // An empty select submits "", which must not read as a connection.
  it("treats a blank connection as none", async () => {
    await createCustodySetupWalletAction(
      walletForm({ provider: "privy", label: "Treasury", connectionId: "  " })
    );

    expect(requestBody(client)).toEqual({ provider: "privy", label: "Treasury" });
  });

  it("sends the purpose the wizard chose, with or without a connection", async () => {
    await createCustodySetupWalletAction(
      walletForm({ provider: "turnkey", label: "Mint", purpose: "mint_authority" })
    );
    expect(requestBody(client)).toEqual({
      provider: "turnkey",
      label: "Mint",
      purpose: "mint_authority",
    });

    client.fetch.mockClear();
    await createCustodySetupWalletAction(
      walletForm({ provider: "privy", label: "Ops", connectionId: "conn_eu", purpose: "transfer" })
    );
    expect(requestBody(client)).toEqual({
      connectionId: "conn_eu",
      label: "Ops",
      purpose: "transfer",
    });
  });

  // The create endpoint accepts five purposes; anything else is the API's to default, never a
  // value the dashboard forwards for it to reject.
  it("leaves out a purpose the create endpoint does not accept", async () => {
    await createCustodySetupWalletAction(
      walletForm({ provider: "turnkey", label: "Settle", purpose: "dvp_settlement_authority" })
    );
    expect(requestBody(client)).toEqual({ provider: "turnkey", label: "Settle" });
  });

  it("refuses a wallet that names neither a provider nor a connection", async () => {
    const result = await createCustodySetupWalletAction(walletForm({ label: "Treasury" }));

    expect(result.status).toBe("error");
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("reports a failure instead of throwing", async () => {
    client.fetch.mockRejectedValue(new Error("SDP API request failed (409): {}"));

    const result = await createCustodySetupWalletAction(
      walletForm({ provider: "privy", label: "Treasury", connectionId: "conn_eu" })
    );

    expect(result.status).toBe("error");
  });
});

describe("requestDevnetSolanaFaucetAction", () => {
  const client = { fetch: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSdpApiClient.mockResolvedValue(client);
  });

  it("revalidates the wallet pages once the API has waited for the airdrop", async () => {
    client.fetch.mockResolvedValue({
      signature: "sig_airdrop",
      status: "confirmed",
      lamports: "1000000000",
    });

    const result = await requestDevnetSolanaFaucetAction("wallet_one");

    expect(result).toEqual({
      status: "success",
      walletId: "wallet_one",
      signature: "sig_airdrop",
      amountSol: 1,
    });
    expect(client.fetch).toHaveBeenCalledWith("/internal/dashboard/wallets/wallet_one/faucet", {
      method: "POST",
    });
    expect(mocks.revalidatePath.mock.calls).toEqual([
      [`/dashboard/${PRODUCTION_PROJECT.id}/custody`],
      [`/dashboard/${PRODUCTION_PROJECT.id}/wallets`],
      [`/dashboard/${PRODUCTION_PROJECT.id}/custody/wallet_one`],
      [`/dashboard/${PRODUCTION_PROJECT.id}/wallets/wallet_one`],
    ]);
  });

  it("reports an airdrop that failed on-chain instead of success", async () => {
    client.fetch.mockResolvedValue({
      signature: "sig_airdrop",
      status: "failed",
      lamports: "1000000000",
    });

    const result = await requestDevnetSolanaFaucetAction("wallet_one");

    expect(result).toEqual({
      status: "error",
      message: "DashboardCustody.devnetFaucetTransactionFailed",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
