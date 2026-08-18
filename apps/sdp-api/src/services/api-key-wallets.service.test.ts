import { expect, it, vi } from "vitest";
import {
  hydrateApiKeyWalletAuthorization,
  loadApiKeyWalletAuthorization,
} from "./api-key-wallets.service";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/runtime/logger", () => ({ getLogger: () => ({ warn }) }));

it("hydrates exact selected-wallet authorization for API-key readers", () => {
  expect(
    hydrateApiKeyWalletAuthorization(
      [
        {
          wallet_id: "wallet_exact",
          custody_wallet_id: "cwlt_exact",
          permissions: JSON.stringify(["payments:write"]),
        },
      ],
      "wallet_exact"
    )
  ).toEqual({
    walletScope: "selected",
    signingWalletId: "wallet_exact",
    signingWalletIds: ["wallet_exact"],
    walletBindings: [
      {
        walletId: "wallet_exact",
        custodyWalletId: "cwlt_exact",
        permissions: ["payments:write"],
      },
    ],
  });
});

it("keeps unresolved wallet selectors selected and fail-closed", () => {
  expect(
    hydrateApiKeyWalletAuthorization(
      [{ wallet_id: "wallet_ambiguous", custody_wallet_id: null, permissions: ["*"] }],
      "wallet_ambiguous"
    )
  ).toEqual({
    walletScope: "selected",
    signingWalletId: "wallet_ambiguous",
    signingWalletIds: [],
    walletBindings: [],
  });
});

it("warns once per selector that does not resolve to exactly one active wallet", async () => {
  warn.mockClear();
  const responses = [
    {
      results: [
        { wallet_id: "wallet_zero", permissions: '["*"]' },
        { wallet_id: "wallet_multi", permissions: '["*"]' },
        { wallet_id: "wallet_ok", permissions: '["*"]' },
      ],
    },
    {
      results: [
        { custody_wallet_id: "cwlt_multi_1", wallet_id: "wallet_multi" },
        { custody_wallet_id: "cwlt_multi_2", wallet_id: "wallet_multi" },
        { custody_wallet_id: "cwlt_ok", wallet_id: "wallet_ok" },
      ],
    },
  ];
  const db = {
    prepare: () => ({ bind: () => ({ all: async () => responses.shift() }) }),
  } as unknown as Parameters<typeof loadApiKeyWalletAuthorization>[0];

  const auth = await loadApiKeyWalletAuthorization(db, "key_1", "org_1", "prj_1", null);

  expect(auth.walletBindings.map((binding) => binding.walletId)).toEqual(["wallet_ok"]);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(
    {
      apiKeyId: "key_1",
      organizationId: "org_1",
      projectId: "prj_1",
      walletId: "wallet_zero",
      candidateCount: 0,
    },
    "api_key_wallet_binding_unresolved"
  );
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ walletId: "wallet_multi", candidateCount: 2 }),
    "api_key_wallet_binding_unresolved"
  );
});

it("does not replace an unresolved preferred wallet with another binding", () => {
  expect(
    hydrateApiKeyWalletAuthorization(
      [
        { wallet_id: "wallet_preferred", custody_wallet_id: null, permissions: ["*"] },
        { wallet_id: "wallet_other", custody_wallet_id: "cwlt_other", permissions: ["*"] },
      ],
      "wallet_preferred"
    )
  ).toEqual({
    walletScope: "selected",
    signingWalletId: "wallet_preferred",
    signingWalletIds: ["wallet_other"],
    walletBindings: [
      {
        walletId: "wallet_other",
        custodyWalletId: "cwlt_other",
        permissions: ["*"],
      },
    ],
  });
});
