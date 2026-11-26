import { beforeEach, describe, expect, it, vi } from "vitest";
import { SdpApiResponseError } from "@/lib/sdp-api";
import { translateServerMessagesToKeys } from "@/test/i18n-server";
import { revalidatePath } from "@/test/next-cache";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";
import {
  type SentSdpApiRequest,
  type StubSdpApiClient,
  sentSdpApiRequests,
  stubSdpApiClient,
} from "@/test/sdp-api-client";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "user_test", orgId: "org_test" })),
}));
vi.mock("next/cache", () => import("@/test/next-cache"));
vi.mock("next/headers", () => import("@/test/next-headers"));

import {
  checkWalletSignerMemoAction,
  createCustodySetupWalletAction,
  initializeCustodySetupAction,
  requestDevnetSolanaFaucetAction,
} from "./actions";

const WALLETS_PATH = `/dashboard/${PRODUCTION_PROJECT.id}/wallets`;
let client: StubSdpApiClient;

beforeEach(() => {
  vi.clearAllMocks();
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/wallet_one`);
  translateServerMessagesToKeys();
  client = stubSdpApiClient();
});

function walletForm(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

/** The one request the action sent to sdp-api. */
function sentRequest(): SentSdpApiRequest {
  const [request, ...others] = sentSdpApiRequests(client);
  if (request === undefined || others.length > 0) {
    throw new Error(`Expected exactly one sdp-api request, got ${client.fetch.mock.calls.length}`);
  }
  return request;
}

describe("initializeCustodySetupAction", () => {
  it("connects the provider under the browser's key and returns the first wallet's ID", async () => {
    client.fetch.mockResolvedValue({ configId: "cfg_new", walletId: "privy_wallet_first" });

    const result = await initializeCustodySetupAction(
      walletForm({
        provider: "privy",
        walletLabel: "Treasury",
        idempotencyKey: "browser-key",
      })
    );

    expect(result).toEqual({ status: "success", walletId: "privy_wallet_first" });
    expect(sentRequest()).toEqual({
      path: "/v1/wallets/managed-signing/initialize-with-wallet",
      method: "POST",
      headers: { "Idempotency-Key": "browser-key" },
      body: { provider: "privy", walletLabel: "Treasury" },
    });
    expect(revalidatePath.mock.calls).toEqual([[WALLETS_PATH]]);
  });

  it("sends Fireblocks setup without an account policy", async () => {
    client.fetch.mockResolvedValue({ configId: "cfg_new", walletId: "fb_wallet_first" });

    await initializeCustodySetupAction(
      walletForm({ provider: "fireblocks", accountPolicy: "shared" })
    );

    expect(sentRequest().body).toEqual({ provider: "fireblocks" });
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

    expect(result).toEqual({
      status: "error",
      message: "DashboardCustody.httpRequestFailed",
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
    expect(sentRequest().path).toBe("/v1/wallets/managed-signing/initialize-with-wallet");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("createCustodySetupWalletAction", () => {
  beforeEach(() => {
    client.fetch.mockResolvedValue({ wallet: { id: "cw_new", walletId: "privy_wallet_new" } });
  });

  // The flow opens the new wallet's page, addressed by its provider wallet ID. A Connection
  // names the credential on its own, so the provider is left out.
  it("creates the wallet in the chosen connection under the browser's key", async () => {
    const result = await createCustodySetupWalletAction(
      walletForm({
        provider: "privy",
        label: "Treasury",
        connectionId: "conn_eu",
        idempotencyKey: "browser-key",
      })
    );

    expect(result).toEqual({ status: "success", walletId: "privy_wallet_new" });
    expect(sentRequest()).toEqual({
      path: "/v1/wallets",
      method: "POST",
      headers: { "Idempotency-Key": "browser-key" },
      body: { connectionId: "conn_eu", label: "Treasury" },
    });
    expect(revalidatePath.mock.calls).toEqual([[WALLETS_PATH]]);
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

    expect(result).toMatchObject({ status: "error", answer: { status, replayed, code: null } });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("names the provider's Managed config when no connection is chosen", async () => {
    await createCustodySetupWalletAction(walletForm({ provider: "privy", label: "Treasury" }));

    expect(sentRequest().body).toEqual({ provider: "privy", label: "Treasury" });
  });

  // An empty select submits "", which must not read as a connection.
  it("treats a blank connection as none", async () => {
    await createCustodySetupWalletAction(
      walletForm({ provider: "privy", label: "Treasury", connectionId: "  " })
    );

    expect(sentRequest().body).toEqual({ provider: "privy", label: "Treasury" });
  });

  it("sends the purpose the wizard chose", async () => {
    await createCustodySetupWalletAction(
      walletForm({ provider: "turnkey", label: "Mint", purpose: "mint_authority" })
    );

    expect(sentRequest().body).toEqual({
      provider: "turnkey",
      label: "Mint",
      purpose: "mint_authority",
    });
  });

  // A purpose the create endpoint does not accept is the API's to default, never a value the
  // dashboard forwards for it to reject.
  it("leaves out a purpose the create endpoint does not accept", async () => {
    await createCustodySetupWalletAction(
      walletForm({ provider: "turnkey", label: "Settle", purpose: "dvp_settlement_authority" })
    );

    expect(sentRequest().body).toEqual({ provider: "turnkey", label: "Settle" });
  });

  it("refuses a wallet that names neither a provider nor a connection", async () => {
    const result = await createCustodySetupWalletAction(walletForm({ label: "Treasury" }));

    expect(result).toMatchObject({
      status: "error",
      answer: { status: null, replayed: false, code: null },
    });
    expect(client.fetch).not.toHaveBeenCalled();
  });
});

describe("checkWalletSignerMemoAction", () => {
  // The check signs in simulation and broadcasts nothing. Under a kept key a
  // press after the user fixed the signer would replay the earlier failure.
  it("probes the signer under no Idempotency-Key", async () => {
    client.fetch.mockResolvedValue({ walletId: "wallet_one", signature: "sig_check" });

    const result = await checkWalletSignerMemoAction(" wallet_one ");

    expect(result).toEqual({ status: "success", walletId: "wallet_one", signature: "sig_check" });
    expect(sentRequest()).toEqual({
      path: "/v1/wallets/signer-check",
      method: "POST",
      headers: undefined,
      body: { walletId: "wallet_one" },
    });
  });
});

describe("requestDevnetSolanaFaucetAction", () => {
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
    expect(revalidatePath.mock.calls).toEqual([[WALLETS_PATH], [`${WALLETS_PATH}/wallet_one`]]);
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
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
