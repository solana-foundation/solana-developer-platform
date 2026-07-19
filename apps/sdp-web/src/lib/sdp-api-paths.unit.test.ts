import { describe, expect, it } from "vitest";
import { getWalletMetadataPath } from "./sdp-api-paths";

describe("SDP API paths", () => {
  it("encodes wallet IDs and opts metadata reads out of balance RPC", () => {
    expect(getWalletMetadataPath("wallet/one")).toBe(
      "/v1/wallets/wallet%2Fone?includeBalance=false"
    );
  });
});
