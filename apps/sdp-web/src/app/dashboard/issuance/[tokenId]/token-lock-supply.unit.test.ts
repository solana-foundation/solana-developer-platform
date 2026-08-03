import type { Token } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";
import {
  getLockSupplyDisabledReason,
  getRemainingMintableSupply,
} from "./token-management-workspace.utils";

const t = (key: MessageKey, values?: TranslationValues) =>
  translate(getMessages("en"), key, values);

// A deployed, active, capped token with the mint authority under custody — the
// one state in which lock-supply is allowed to run.
function makeToken(overrides: Partial<Token> = {}): Token {
  return {
    id: "tok_test",
    projectId: "prj_test",
    organizationId: "org_test",
    signingWalletId: "wal_test",
    mintAddress: "8xKqL2mNpQrStUvWxYz1234567890abcdefGHIJK",
    mintAuthority: "7xKq9fA2mNpQrStUvWxYz1234567890abcdefGHI",
    metadataAuthority: null,
    freezeAuthority: null,
    ablListAddress: null,
    name: "Verde Dollar",
    symbol: "VUSD",
    decimals: 6,
    description: null,
    uri: null,
    imageUrl: null,
    template: "stablecoin",
    extensions: null,
    totalSupply: "250000",
    maxSupply: "1000000",
    isMintable: true,
    isFreezable: true,
    requiresAllowlist: false,
    status: "active",
    deployedAt: "2026-02-01T00:00:00.000Z",
    createdBy: "user_test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getRemainingMintableSupply", () => {
  it("returns null when the token has no cap", () => {
    // Doubles as the signal the Operations tab uses to hide the action entirely.
    expect(getRemainingMintableSupply(makeToken({ maxSupply: null }))).toBeNull();
  });

  it("returns the gap between current supply and the cap", () => {
    expect(getRemainingMintableSupply(makeToken())).toBe("750000");
  });

  it("returns the whole cap when nothing has been minted", () => {
    expect(getRemainingMintableSupply(makeToken({ totalSupply: "0" }))).toBe("1000000");
  });

  it("returns 0 when supply already equals the cap", () => {
    // Lock-supply then degenerates to a bare revoke, which is still valid.
    expect(getRemainingMintableSupply(makeToken({ totalSupply: "1000000" }))).toBe("0");
  });

  it("clamps to 0 rather than going negative when supply exceeds the cap", () => {
    expect(getRemainingMintableSupply(makeToken({ totalSupply: "1500000" }))).toBe("0");
  });

  it("handles fractional amounts at the token's precision", () => {
    expect(
      getRemainingMintableSupply(makeToken({ decimals: 6, totalSupply: "0.5", maxSupply: "1.25" }))
    ).toBe("0.75");
  });

  it("returns null when a figure carries more precision than the mint allows", () => {
    // Refusing beats guessing: the caller must not mint a rounded amount.
    expect(
      getRemainingMintableSupply(makeToken({ decimals: 0, totalSupply: "0", maxSupply: "1.5" }))
    ).toBeNull();
  });

  it("returns null when a figure is not a decimal string", () => {
    expect(getRemainingMintableSupply(makeToken({ totalSupply: "n/a" }))).toBeNull();
  });
});

describe("getLockSupplyDisabledReason", () => {
  it("allows the action on a deployed, active, capped token", () => {
    expect(getLockSupplyDisabledReason(makeToken(), t)).toBeNull();
  });

  it("still allows it when supply already sits at the cap", () => {
    expect(getLockSupplyDisabledReason(makeToken({ totalSupply: "1000000" }), t)).toBeNull();
  });

  it("blocks when no cap is configured", () => {
    expect(getLockSupplyDisabledReason(makeToken({ maxSupply: null }), t)).toBe(
      t("DashboardIssuance.management.lockSupplyNoMaxSupply")
    );
  });

  it("blocks when the mint authority was already revoked via isMintable", () => {
    expect(getLockSupplyDisabledReason(makeToken({ isMintable: false }), t)).toBe(
      t("DashboardIssuance.management.lockSupplyAlreadyLocked")
    );
  });

  it("blocks when there is no mint authority to revoke", () => {
    expect(getLockSupplyDisabledReason(makeToken({ mintAuthority: null }), t)).toBe(
      t("DashboardIssuance.management.lockSupplyAlreadyLocked")
    );
  });

  it("blocks when the remaining amount cannot be calculated", () => {
    expect(getLockSupplyDisabledReason(makeToken({ totalSupply: "n/a" }), t)).toBe(
      t("DashboardIssuance.management.lockSupplyAmountUnavailable")
    );
  });

  it.each([
    "pending",
    "paused",
    "revoked",
  ] as const)("blocks on a %s token via the mint lifecycle gate", (status) => {
    // Leg 1 is a real mint, so lock-supply inherits mint's lifecycle rules.
    expect(getLockSupplyDisabledReason(makeToken({ status }), t)).not.toBeNull();
  });
});
