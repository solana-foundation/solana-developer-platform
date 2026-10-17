import { expect, it, vi } from "vitest";
import {
  hydrateApiKeyWalletAuthorization,
  resetUnresolvedBindingWarningsForTesting,
  resolveApiKeyWalletAuthorization,
  UNRESOLVED_BINDING_WARNING_INTERVAL_MS,
  warnUnresolvedApiKeyWalletBindings,
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

const UNRESOLVED_ROWS = [
  { wallet_id: "wallet_zero", permissions: '["*"]', candidates: [] },
  {
    wallet_id: "wallet_multi",
    permissions: '["*"]',
    candidates: [
      { id: "cwlt_multi_1", status: "active" },
      { id: "cwlt_multi_2", status: "active" },
    ],
  },
  {
    wallet_id: "wallet_ok",
    permissions: '["*"]',
    candidates: [{ id: "cwlt_ok", status: "active" }],
  },
];
const KEY = { apiKeyId: "key_1", organizationId: "org_1", projectId: "prj_1" };

it("warns for each selector that does not resolve to exactly one active wallet", () => {
  resetUnresolvedBindingWarningsForTesting();
  warn.mockClear();

  warnUnresolvedApiKeyWalletBindings(UNRESOLVED_ROWS, KEY, 0);

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

it("logs one key's unresolved bindings at most once per interval", () => {
  resetUnresolvedBindingWarningsForTesting();
  warn.mockClear();

  warnUnresolvedApiKeyWalletBindings(UNRESOLVED_ROWS, KEY, 0);
  warnUnresolvedApiKeyWalletBindings(
    UNRESOLVED_ROWS,
    KEY,
    UNRESOLVED_BINDING_WARNING_INTERVAL_MS - 1
  );
  expect(warn).toHaveBeenCalledTimes(2);

  // Another key is not held back by the first one's quiet period.
  warnUnresolvedApiKeyWalletBindings(UNRESOLVED_ROWS, { ...KEY, apiKeyId: "key_2" }, 1);
  expect(warn).toHaveBeenCalledTimes(4);

  warnUnresolvedApiKeyWalletBindings(UNRESOLVED_ROWS, KEY, UNRESOLVED_BINDING_WARNING_INTERVAL_MS);
  expect(warn).toHaveBeenCalledTimes(6);
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

// Wallet status is state, not access: a binding still names its deactivated
// wallet, so a replay passes the same check as the original request.
it("resolves a binding to its one active wallet, else to its one wallet of any status", () => {
  const auth = resolveApiKeyWalletAuthorization(
    [
      {
        wallet_id: "wallet_reimported",
        permissions: '["*"]',
        candidates: [
          { id: "cwlt_old", status: "inactive" },
          { id: "cwlt_new", status: "active" },
        ],
      },
      {
        wallet_id: "wallet_deactivated",
        permissions: '["*"]',
        candidates: [{ id: "cwlt_deactivated", status: "inactive" }],
      },
      {
        wallet_id: "wallet_ambiguous",
        permissions: '["*"]',
        candidates: [
          { id: "cwlt_inactive_1", status: "inactive" },
          { id: "cwlt_inactive_2", status: "inactive" },
        ],
      },
    ],
    null
  );

  expect(auth.walletBindings).toEqual([
    { walletId: "wallet_reimported", custodyWalletId: "cwlt_new", permissions: ["*"] },
    { walletId: "wallet_deactivated", custodyWalletId: "cwlt_deactivated", permissions: ["*"] },
  ]);
  expect(auth.walletScope).toBe("selected");
});
