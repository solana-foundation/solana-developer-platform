import { readFileSync } from "node:fs";
import path from "node:path";
import { actionVerbOf, isAction, isApiKeyGrantableAction } from "@sdp/types/actions";
import { MOVEMENTS } from "@sdp/types/movements";
import { SDP_RAMP_PROVIDER_STAGES, type SdpModule } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { registeredRouteAuthorizations } from "@/routes/route-actions";
import { routeOwnerOf } from "@/routes/route-modules";

/**
 * Early wallet-scope refusals, as a build gate (HOO-2099).
 *
 * The custody signer decides every signature, so a route that never checks a
 * selected key's wallet scope is still refused when it signs. But by then it
 * may have recorded a failed movement, claimed an attempt or called a
 * gateway, and the Idempotency-Key replays that refusal after the key's scope
 * is fixed. So every value-moving route either refuses an out-of-scope
 * wallet before it writes anything, proven by a named test that asserts
 * `wallet_out_of_scope`, or says here why it need not.
 *
 * The routes come from the app: every POST, PATCH, PUT and DELETE under `/v1`
 * owned by a module that has a movement, whose action a key may hold and is
 * not a `read`. A new one fails here until it is classified.
 */

type Classification =
  /** A test in `file` (under `src/`) named `test` asserts the route's 403 `wallet_out_of_scope`. */
  | { refusedEarly: { file: string; test: string }; via?: string }
  /** Signs with no custody wallet, or writes nothing before the custody signer decides. */
  | { exempt: string }
  /** Refused only by the custody signer, after a write. Pinned until fixed. */
  | { gap: string };

const SIGNS_NOTHING = "signs nothing";
const SPONSOR_ONLY =
  "the caller's own wallet signs; SDP signs at most as fee sponsor, which is outside wallet scope";
const CUSTODY_404 =
  "signs nothing; a wallet outside a selected key's scope answers 404 in its authorize step";

const TRANSFERS = "routes/payments.transfers.idempotency.test.ts";
const RECURRING = "routes/payments.recurring.test.ts";
const RECURRING_ACTIVE =
  "refuses $route on an active mandate by a selected-wallet key outside its source wallet";
const DVP = "routes/dvp.test.ts";
const DVP_ACTIONS = "refuses $action with wallet_out_of_scope, writing nothing";
const EARN_EXITS = "routes/earn.vault-withdrawals.test.ts";
const ISSUANCE_BURN = {
  file: "routes/issuance.test.ts",
  test: "refuses a burn from a wallet outside the key's scope before writing its row",
};
const ISSUANCE_RESOLVER =
  "resolveIssuanceWallet / resolveAuthorityWallet, which every issuance signing route resolves its wallet through";
const RINGS = {
  file: "routes/helius-rings.test.ts",
  test: "refuses $route with wallet_out_of_scope, writing nothing",
};
const PC_MOVEMENTS = {
  file: "routes/private-channels.value-movement.test.ts",
  test: "refuses a selected-scope API key naming an enrolled wallet it is not bound to",
};
const LEGACY_DEPLOY =
  "legacy client-signed deploy: createLegacyResolvedAuthoritySigner reaches the custody signer without an early scope check; unverified whether anything is written first";

const WALLET_SCOPE_ROUTES = {
  // Custody
  "POST /v1/wallets": { exempt: "creates a wallet; signs nothing" },
  "PATCH /v1/wallets/:walletId": { exempt: CUSTODY_404 },
  "DELETE /v1/wallets": { exempt: CUSTODY_404 },
  "POST /v1/wallets/signer-check": {
    refusedEarly: {
      file: "routes/custody-signer-check-scope.test.ts",
      test: "refuses a wallet outside the key's scope before claiming the key",
    },
  },

  // Payments
  "POST /v1/payments/transfers": {
    refusedEarly: {
      file: TRANSFERS,
      test: "refuses a transfer from a wallet outside the key's scope before writing anything",
    },
  },
  "POST /v1/payments/transfer-batches": {
    refusedEarly: {
      file: "routes/payments/transfer-batches/handlers.test.ts",
      test: "refuses a batch from a wallet outside the key's scope before writing anything",
    },
  },
  "POST /v1/payments/requests": { exempt: "a `/pay` link: SDP signs only as fee sponsor" },
  "POST /v1/counterparties": { exempt: SIGNS_NOTHING },
  "PATCH /v1/counterparties/:counterpartyId": { exempt: SIGNS_NOTHING },
  "DELETE /v1/counterparties/:counterpartyId": { exempt: SIGNS_NOTHING },
  "POST /v1/counterparties/:counterpartyId/accounts": { exempt: SIGNS_NOTHING },
  "PATCH /v1/counterparties/:counterpartyId/accounts/:counterpartyAccountId": {
    exempt: SIGNS_NOTHING,
  },
  "DELETE /v1/counterparties/:counterpartyId/accounts/:counterpartyAccountId": {
    exempt: SIGNS_NOTHING,
  },

  // Ramps: a quote signs nothing, so its money admission is its only scope check.
  "POST /v1/payments/ramps/onramp/quote": {
    refusedEarly: {
      file: "routes/payments.ramps-money-admission.test.ts",
      test: "refuses a %s quote on a wallet outside the key's scope with wallet_out_of_scope",
    },
  },
  "POST /v1/payments/ramps/offramp/quote": {
    refusedEarly: {
      file: "routes/payments.ramps-money-admission.test.ts",
      test: "refuses a %s quote on a wallet outside the key's scope with wallet_out_of_scope",
    },
  },
  "POST /v1/payments/ramps/sandbox/simulate": { exempt: "a provider sandbox event; signs nothing" },
  "POST /v1/payments/ramps/transfers/cancel": { exempt: "a provider-side cancel; signs nothing" },
  "POST /v1/counterparties/:counterpartyId/requirements": { exempt: SIGNS_NOTHING },

  // Recurring payments
  "POST /v1/payments/recurring-payments": {
    exempt: "creates a pending mandate, which signs nothing until it is activated",
  },
  "PATCH /v1/payments/recurring-payments/:id": {
    refusedEarly: { file: RECURRING, test: RECURRING_ACTIVE },
  },
  "POST /v1/payments/recurring-payments/:id/activate": {
    refusedEarly: {
      file: RECURRING,
      test: "refuses activation by a selected-wallet key outside the source wallet, before claiming it",
    },
  },
  "POST /v1/payments/recurring-payments/:id/collect": {
    refusedEarly: { file: RECURRING, test: RECURRING_ACTIVE },
  },
  "POST /v1/payments/recurring-payments/:id/resume": {
    refusedEarly: { file: RECURRING, test: RECURRING_ACTIVE },
  },
  "POST /v1/payments/recurring-payments/:id/cancel": {
    refusedEarly: { file: RECURRING, test: RECURRING_ACTIVE },
  },
  "POST /v1/payments/subscription-plans": { exempt: SPONSOR_ONLY },
  "PATCH /v1/payments/subscription-plans/:planId": { exempt: SPONSOR_ONLY },
  "POST /v1/payments/subscription-plans/:planId/prepare-create": { exempt: SPONSOR_ONLY },
  "POST /v1/payments/subscriptions": { exempt: SPONSOR_ONLY },
  "POST /v1/payments/subscriptions/:subscriptionId/prepare-authorization": {
    exempt: SPONSOR_ONLY,
  },
  "POST /v1/payments/subscriptions/:subscriptionId/prepare-cancel": { exempt: SPONSOR_ONLY },
  "POST /v1/payments/subscriptions/:subscriptionId/prepare-collection": { exempt: SPONSOR_ONLY },
  "POST /v1/payments/subscriptions/:subscriptionId/prepare-resume": { exempt: SPONSOR_ONLY },

  // DvP
  "POST /v1/dvp/trades": {
    refusedEarly: {
      file: DVP,
      test: "refuses a create whose settlement wallet is $settlementWallet, provisioning and recording nothing",
    },
  },
  "POST /v1/dvp/trades/:tradeId/fund": {
    refusedEarly: {
      file: DVP,
      test: "refuses a side whose wallet the key does not list, writing no claim",
    },
  },
  "POST /v1/dvp/trades/:tradeId/reclaim": { refusedEarly: { file: DVP, test: DVP_ACTIONS } },
  "POST /v1/dvp/trades/:tradeId/settle": { refusedEarly: { file: DVP, test: DVP_ACTIONS } },
  "POST /v1/dvp/trades/:tradeId/cancel": { refusedEarly: { file: DVP, test: DVP_ACTIONS } },

  // Earn
  "POST /v1/earn/vault-deposits": {
    refusedEarly: {
      file: "routes/earn.vault.test.ts",
      test: "refuses a wallet outside the key's scope before opening an audit intent or deposit",
    },
  },
  "POST /v1/earn/vault-withdrawals": {
    refusedEarly: {
      file: EARN_EXITS,
      test: "refuses a withdrawal with wallet_out_of_scope before recording a movement",
    },
  },
  "POST /v1/earn/vault-withdrawal-requests": {
    refusedEarly: {
      file: EARN_EXITS,
      test: "refuses a withdrawal request with wallet_out_of_scope before recording it",
    },
  },
  "POST /v1/earn/vault-withdrawal-requests/:withdrawalRequestId/cancel": {
    refusedEarly: {
      file: EARN_EXITS,
      test: "refuses a withdrawal request cancellation with wallet_out_of_scope, leaving the request unchanged",
    },
  },
  "POST /v1/earn/programs/:programId/withdrawals": {
    refusedEarly: {
      file: "routes/earn-program.test.ts",
      test: "refuses a wallet-scoped key on the payout, before the provider is driven",
    },
  },
  "POST /v1/earn/programs": { exempt: "links a provider account; signs nothing" },
  "PUT /v1/earn/programs/:programId": { exempt: "edits a provider account link; signs nothing" },
  "POST /v1/earn/external-wallet/deposit-transactions": { exempt: SPONSOR_ONLY },
  "POST /v1/earn/external-wallet/deposits": { exempt: SPONSOR_ONLY },
  "POST /v1/earn/external-wallet/withdrawal-transactions": { exempt: SPONSOR_ONLY },
  "POST /v1/earn/external-wallet/withdrawals": { exempt: SPONSOR_ONLY },
  "POST /v1/earn/external-wallet/withdrawal-request-transactions": { exempt: SPONSOR_ONLY },
  "POST /v1/earn/external-wallet/withdrawal-requests": { exempt: SPONSOR_ONLY },
  "POST /v1/earn/external-wallet/withdrawal-request-cancel-transactions": {
    exempt: SPONSOR_ONLY,
  },
  "POST /v1/earn/external-wallet/withdrawal-request-cancellations": { exempt: SPONSOR_ONLY },

  // Issuance
  "POST /v1/issuance/tokens/:tokenId/burn": { refusedEarly: ISSUANCE_BURN },
  "POST /v1/issuance/tokens": { refusedEarly: ISSUANCE_BURN, via: ISSUANCE_RESOLVER },
  "PATCH /v1/issuance/tokens/:tokenId": { refusedEarly: ISSUANCE_BURN, via: ISSUANCE_RESOLVER },
  "POST /v1/issuance/tokens/:tokenId/deploy": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/deploy/prepare": { gap: LEGACY_DEPLOY },
  "POST /v1/issuance/tokens/:tokenId/deploy/prepare-metadata": { gap: LEGACY_DEPLOY },
  "POST /v1/issuance/tokens/:tokenId/deploy/confirm": { gap: LEGACY_DEPLOY },
  "POST /v1/issuance/tokens/:tokenId/mint": { refusedEarly: ISSUANCE_BURN, via: ISSUANCE_RESOLVER },
  "POST /v1/issuance/tokens/:tokenId/mint/prepare": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/burn/prepare": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/seize": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/seize/prepare": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/force-burn": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/force-burn/prepare": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/authority": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/authority/prepare": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/pause": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/unpause": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/freeze": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/unfreeze": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/allowlist": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "DELETE /v1/issuance/tokens/:tokenId/allowlist/:entryId": {
    refusedEarly: ISSUANCE_BURN,
    via: ISSUANCE_RESOLVER,
  },
  "POST /v1/issuance/tokens/:tokenId/holders": { exempt: "enrolls a KYC holder; signs nothing" },
  "POST /v1/issuance/asset-profiles": { refusedEarly: ISSUANCE_BURN, via: ISSUANCE_RESOLVER },
  "PATCH /v1/issuance/asset-profiles/:profileId": { exempt: SIGNS_NOTHING },
  "DELETE /v1/issuance/asset-profiles/:profileId": { exempt: SIGNS_NOTHING },

  // Private Channels
  "POST /v1/private-channels/deposits": { refusedEarly: PC_MOVEMENTS },
  "POST /v1/private-channels/withdrawals": { refusedEarly: PC_MOVEMENTS },
  "POST /v1/private-channels/channels/:channelId/transfers": {
    refusedEarly: {
      file: "routes/private-channels.transfers.test.ts",
      test: "refuses a selected-scope API key naming an enrolled wallet it is not bound to",
    },
  },
  "POST /v1/private-channels/wallets/:walletId/verify": {
    refusedEarly: {
      file: "routes/private-channels.value-movement.test.ts",
      test: "refuses verification of a wallet outside the key's current wallet grants",
    },
  },
  "POST /v1/private-channels/channels": { exempt: SIGNS_NOTHING },
  "DELETE /v1/private-channels/channels/:id": { exempt: SIGNS_NOTHING },
  "DELETE /v1/private-channels/wallets/:pubkey": { exempt: SIGNS_NOTHING },

  // Helius Rings
  "POST /v1/helius-rings/wallets": { refusedEarly: RINGS },
  "POST /v1/helius-rings/wallets/:walletId/sync": { refusedEarly: RINGS },
  "POST /v1/helius-rings/wallets/:walletId/rekey": { refusedEarly: RINGS },
  "POST /v1/helius-rings/wallets/:walletId/zones": { refusedEarly: RINGS },
  "POST /v1/helius-rings/operations": { refusedEarly: RINGS },
  "POST /v1/helius-rings/operations/:operationId/execute": { refusedEarly: RINGS },
  "POST /v1/helius-rings/operations/:operationId/retry": { refusedEarly: RINGS },
  "POST /v1/helius-rings/operations/:operationId/recheck": { refusedEarly: RINGS },
  "POST /v1/helius-rings/operations/:operationId/void": { refusedEarly: RINGS },
  "POST /v1/helius-rings/rings": {
    gap: "ring bring-up reserves the ring row, then signs with the custody wallet that owns the ring authority; no early scope check",
  },
} as const satisfies Record<string, Classification>;

const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const MOVEMENT_MODULES: ReadonlySet<SdpModule> = new Set(
  Object.values(MOVEMENTS).map((movement) => movement.module)
);

function valueMovingRoutes(): string[] {
  const app = createApp({ rampProviderStages: SDP_RAMP_PROVIDER_STAGES });
  return registeredRouteAuthorizations(app)
    .flatMap((route) => {
      if (!MUTATING_METHODS.has(route.method) || !route.path.startsWith("/v1/")) return [];
      const owner = routeOwnerOf(route.path);
      if (owner === undefined || owner === "core" || !MOVEMENT_MODULES.has(owner)) return [];
      const [declaration] = route.declarations;
      if (declaration?.kind !== "action" || !isAction(declaration.action)) return [];
      const action = declaration.action;
      if (actionVerbOf(action) === "read" || !isApiKeyGrantableAction(action)) return [];
      return [`${route.method} ${route.path}`];
    })
    .sort();
}

/** A test's body: from its title to the next test or describe. */
function testBlock(source: string, title: string): string | null {
  const start = source.indexOf(title);
  if (start === -1) return null;
  const rest = source.slice(start + title.length);
  const next = rest.search(/\n\s*(it|test|describe)(\.each)?[(<]/);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Whether the test titled `title` would not run: its own declaration is
 * `skip`, `todo` or `x`-prefixed, or the file skips a describe (which may
 * enclose it). A disabled test is no evidence.
 */
function isDisabledTest(source: string, title: string): boolean {
  const start = source.indexOf(title);
  if (start === -1) return false;
  if (/\b(?:xdescribe|describe(?:\.\w+)*\.(?:skip|todo))\s*[(<]/.test(source)) return true;
  const declarations = [
    ...source.slice(0, start).matchAll(/\b(x?)(?:it|test)((?:\.\w+)*)\s*[(<]/g),
  ];
  const own = declarations.at(-1);
  return own !== undefined && (own[1] === "x" || /\.(?:skip|todo)\b/.test(own[2] ?? ""));
}

const SRC = path.resolve(__dirname, "..");
const classified: Record<string, Classification> = WALLET_SCOPE_ROUTES;

describe("wallet-scope route inventory", () => {
  const routes = valueMovingRoutes();

  it("finds the value-moving routes", () => {
    expect(routes.length).toBeGreaterThan(80);
  });

  it("classifies every value-moving route", () => {
    expect(routes.filter((route) => !(route in classified))).toEqual([]);
  });

  it("keeps every classification current", () => {
    expect(Object.keys(classified).filter((route) => !routes.includes(route))).toEqual([]);
  });

  it.each(
    Object.entries(classified).flatMap(([route, classification]) =>
      "refusedEarly" in classification ? [[route, classification.refusedEarly] as const] : []
    )
  )("%s: its named test asserts wallet_out_of_scope", (_route, { file, test }) => {
    const source = readFileSync(path.join(SRC, file), "utf8");
    const block = testBlock(source, test);
    expect(block, `${file} has no test named "${test}"`).not.toBeNull();
    expect(block).toMatch(/wallet_?out_?of_?scope/i);
    expect(isDisabledTest(source, test), `${file} skips "${test}"`).toBe(false);
  });

  it("counts a skipped or todo test as no evidence", () => {
    const title = "refuses it out of scope";
    const body = `("${title}", async () => { expect(error).toBe("wallet_out_of_scope"); });`;
    expect(isDisabledTest(`it${body}`, title)).toBe(false);
    expect(isDisabledTest(`it.each([1])${body}`, title)).toBe(false);
    expect(isDisabledTest(`it.skip${body}`, title)).toBe(true);
    expect(isDisabledTest(`it.skip.each([1])${body}`, title)).toBe(true);
    expect(isDisabledTest(`test.todo${body}`, title)).toBe(true);
    expect(isDisabledTest(`xit${body}`, title)).toBe(true);
    expect(isDisabledTest(`describe.skip("group", () => { it${body} });`, title)).toBe(true);
  });

  // Each gap is a route the custody signer alone refuses, after a write.
  // Fixing one moves it to `refusedEarly` with its test.
  it("pins the routes still refused only at signing", () => {
    expect(
      Object.entries(classified)
        .filter(([, classification]) => "gap" in classification)
        .map(([route]) => route)
    ).toEqual([
      "POST /v1/issuance/tokens/:tokenId/deploy/prepare",
      "POST /v1/issuance/tokens/:tokenId/deploy/prepare-metadata",
      "POST /v1/issuance/tokens/:tokenId/deploy/confirm",
      "POST /v1/helius-rings/rings",
    ]);
  });
});
