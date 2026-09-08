import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveIssuanceDraft } from "./actions";

const mocks = vi.hoisted(() => ({ request: vi.fn(), wallets: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/sdp-api", () => ({ createSdpApiClient: async () => ({ request: mocks.request }) }));
vi.mock("../../payments/payments-page.data", () => ({ fetchPaymentsWallets: mocks.wallets }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
const input = {
  assetClass: "stablecoin",
  name: "Example",
  symbol: "EX",
  description: "",
  website: "",
  maxSupply: "",
  decimals: "6",
  allowlist: false,
  pauseTransfers: true,
  interestBearing: false,
  interestRate: "500",
  transferFee: false,
  transferFeeBasisPoints: "50",
  transferFeeMax: "100",
  authorities: {
    "mint-authority": "wallet-a",
    "metadata-authority": "wallet-a",
    "freeze-authority": "wallet-a",
    "permanent-delegate": "wallet-a",
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.wallets.mockResolvedValue({ ok: true, data: [{ walletId: "wallet-a" }] });
  mocks.request.mockResolvedValue(
    new Response(JSON.stringify({ data: { token: { id: "tok_saved" } } }), { status: 201 })
  );
});
describe("save issuance draft", () => {
  it("creates an asset profile, invalidates the list, and never calls deploy", async () => {
    expect(await saveIssuanceDraft(input)).toMatchObject({
      state: "success",
      tokenId: "tok_saved",
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith(
      "/v1/issuance/asset-profiles",
      expect.objectContaining({ method: "POST" })
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/dashboard/issuance");
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toMatchObject({
      signingWalletId: "wallet-a",
    });
  });
  it("does not save a wallet outside the available project wallets", async () => {
    mocks.wallets.mockResolvedValue({ ok: true, data: [] });
    expect(await saveIssuanceDraft(input)).toMatchObject({ state: "error" });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("does not request an API mutation for invalid input", async () => {
    expect(await saveIssuanceDraft({})).toMatchObject({ state: "error" });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("keeps a failed save on the form", async () => {
    mocks.request.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Rejected" } }), { status: 400 })
    );
    expect(await saveIssuanceDraft(input)).toMatchObject({ state: "error" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
