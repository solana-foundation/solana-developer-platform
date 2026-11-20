import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { type ComponentProps, isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as providerAvailability from "@/lib/provider-availability.server";
import * as sdpApi from "@/lib/sdp-api";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { setPageRequest } from "@/test/request-project";
import { syntheticWalletAddress } from "@/test/wallets";

const { mockIssuanceFlag } = vi.hoisted(() => ({ mockIssuanceFlag: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ orgId: "org_test" })),
}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
// The deployment's Issuance flag.
vi.mock("@/flags", () => ({ issuance: mockIssuanceFlag }));

import { WalletDetailPage } from "./wallet-detail-page";
import { WalletDetailView } from "./wallet-detail-view";

type ViewProps = ComponentProps<typeof WalletDetailView>;

const solBalance: CustodyWalletTokenBalance = {
  token: WELL_KNOWN_TOKENS.SOL.symbol,
  mint: SOL_MINT,
  amount: "0",
  uiAmount: "0",
  decimals: WELL_KNOWN_TOKENS.SOL.mints.devnet.decimals,
};

const CONNECTION_PATH = "/internal/dashboard/custody/connections/connection_one";

const request = vi.fn<(path: string) => Promise<Response>>();
const fetchAvailability = vi.fn<typeof providerAvailability.fetchProjectProviderAvailability>();
let walletOverrides: Record<string, unknown> = {};

async function defaultApiResponse(path: string): Promise<Response> {
  if (path === "/v1/wallets/wallet%2Fone?includeBalance=false") {
    return Response.json({
      data: {
        wallet: {
          id: "wallet_record",
          custodyConfigId: "config_test",
          provider: "privy",
          isDefaultProvider: true,
          isRuntimeExecutionAllowed: true,
          walletId: "wallet/one",
          publicKey: syntheticWalletAddress(1),
          label: "Fast wallet",
          purpose: null,
          status: "active",
          createdAt: "2026-07-18T00:00:00.000Z",
          ...walletOverrides,
        },
      },
    });
  }
  if (path === "/v1/payments/wallets/wallet%2Fone/balances") {
    return Response.json({ data: { walletBalances: { balances: [solBalance] } } });
  }
  if (path === "/v1/issuance/tokens?page=1&pageSize=100") {
    return Response.json({ data: [] });
  }
  if (path === CONNECTION_PATH) {
    return Response.json({
      data: {
        connection: {
          id: "connection_one",
          provider: "privy",
          label: "Treasury connection",
          status: "active",
          completion: null,
          isDefault: true,
          canComplete: false,
          canReplaceCredentials: false,
          canCancel: false,
        },
      },
    });
  }
  throw new Error(`Unexpected request: ${path}`);
}

/** Answers `path` with `answer`, and every other request as the wallet's defaults. */
function answering(path: string, answer: () => Promise<Response>) {
  request.mockImplementation(async (requested) =>
    requested === path ? answer() : defaultApiResponse(requested)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  walletOverrides = {};
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/wallet%2Fone`);
  mockIssuanceFlag.mockResolvedValue(true);
  request.mockImplementation(defaultApiResponse);
  vi.spyOn(sdpApi, "createSdpApiClient").mockResolvedValue({ request, fetch: vi.fn() });
  vi.spyOn(sdpApi, "requestMemberRole").mockResolvedValue("member");
  vi.spyOn(providerAvailability, "fetchProjectProviderAvailability").mockImplementation(
    fetchAvailability
  );
});

/** The view the page hands its wallet to, with what it read. */
async function renderPage(): Promise<ViewProps> {
  const page = await WalletDetailPage({ params: Promise.resolve({ walletId: "wallet%2Fone" }) });
  if (!isValidElement<ViewProps>(page) || page.type !== WalletDetailView) {
    throw new Error("The page did not render the wallet's view");
  }
  return page.props;
}

function requestedPaths(): string[] {
  return request.mock.calls.map(([path]) => path);
}

describe("WalletDetailPage", () => {
  it("names the wallet and its provider, and says what it can sign", async () => {
    const { wallet } = await renderPage();

    expect(wallet).toEqual({
      walletId: "wallet/one",
      custodyWalletId: "wallet_record",
      name: "Fast wallet",
      label: "Fast wallet",
      publicKey: syntheticWalletAddress(1),
      provider: "privy",
      providerName: "Privy",
      purposeLabel: null,
      createdAt: "2026-07-18T00:00:00.000Z",
      isRuntimeExecutionAllowed: true,
      supportsSignerCheck: true,
      connection: null,
      canManageCustody: false,
    });
  });

  it("calls an unlabelled wallet untitled rather than by its address", async () => {
    walletOverrides = { label: null };

    const { wallet } = await renderPage();

    expect(wallet.name).toBe("DashboardCustody.untitledWallet");
    expect(wallet.label).toBeNull();
  });

  it("renders the project's not-found page for a wallet the API does not find", async () => {
    answering("/v1/wallets/wallet%2Fone?includeBalance=false", async () =>
      Response.json({ error: { message: "Wallet not found" } }, { status: 404 })
    );

    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("does not request admin-only connection data for a member", async () => {
    walletOverrides = { custodyConnectionId: "connection_one" };

    const { wallet } = await renderPage();

    expect(requestedPaths()).not.toContain(CONNECTION_PATH);
    expect(fetchAvailability).not.toHaveBeenCalled();
    expect(wallet.connection).toEqual({ label: "connec..._one", href: null });
    expect(wallet.canManageCustody).toBe(false);
  });

  it("loads the wallet's exact connection and links its label for an admin", async () => {
    walletOverrides = { custodyConnectionId: "connection_one" };
    vi.mocked(sdpApi.requestMemberRole).mockResolvedValue("admin");
    fetchAvailability.mockResolvedValue(
      projectProviderAvailability({
        project: PRODUCTION_PROJECT,
        custody: [{ provider: "privy", modes: ["byok"] }],
        compliance: [],
        ramps: [],
        earn: [],
      })
    );

    const { wallet } = await renderPage();

    expect(requestedPaths()).toContain(CONNECTION_PATH);
    expect(wallet.connection).toEqual({
      label: "Treasury connection",
      href: `/dashboard/${PRODUCTION_PROJECT.id}/integrations/privy/connections/connection_one`,
    });
    expect(wallet.canManageCustody).toBe(true);
  });

  it("leaves the connection label unlinked for an admin when the project does not offer privy in byok", async () => {
    walletOverrides = { custodyConnectionId: "connection_one" };
    vi.mocked(sdpApi.requestMemberRole).mockResolvedValue("admin");
    fetchAvailability.mockResolvedValue(
      projectProviderAvailability({
        project: PRODUCTION_PROJECT,
        custody: [],
        compliance: [],
        ramps: [],
        earn: [],
      })
    );

    const { wallet } = await renderPage();

    expect(wallet.connection).toEqual({ label: "Treasury connection", href: null });
  });

  it.each([403, 404])(
    "shows the truncated connection id, unlinked, when the connection lookup returns %i",
    async (status) => {
      walletOverrides = { custodyConnectionId: "connection_one" };
      vi.mocked(sdpApi.requestMemberRole).mockResolvedValue("admin");
      answering(CONNECTION_PATH, async () => new Response(null, { status }));

      const { wallet } = await renderPage();

      expect(wallet.connection).toEqual({ label: "connec..._one", href: null });
      expect(fetchAvailability).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "http",
      async () => new Response(null, { status: 503 }),
      { name: "ConnectionDetailRequestError", status: 503 },
    ],
    [
      "network",
      async () => {
        throw new Error("Connection unavailable");
      },
      { message: "Connection unavailable" },
    ],
    ["invalid response", async () => Response.json({ data: {} }), { name: "ZodError" }],
  ])(
    "propagates a connection lookup %s failure instead of rendering the wallet without it",
    async (_failure, connectionResponse, expectedError) => {
      walletOverrides = { custodyConnectionId: "connection_one" };
      vi.mocked(sdpApi.requestMemberRole).mockResolvedValue("admin");
      answering(CONNECTION_PATH, connectionResponse);

      await expect(renderPage()).rejects.toMatchObject(expectedError);
    }
  );

  it("hands the balances and issued tokens over as promises", async () => {
    const props = await renderPage();

    await expect(props.balancesPromise).resolves.toEqual({ balances: [solBalance], error: null });
    await expect(props.issuedTokensPromise).resolves.toEqual({});
  });

  it("reports the balances as unavailable when their read fails", async () => {
    answering("/v1/payments/wallets/wallet%2Fone/balances", async () =>
      Response.json({ error: { message: "upstream" } }, { status: 502 })
    );

    const props = await renderPage();

    await expect(props.balancesPromise).resolves.toEqual({
      balances: [],
      error: "DashboardCustody.trackedBalancesUnavailable",
    });
  });

  it("never reads issued tokens where Issuance is off", async () => {
    mockIssuanceFlag.mockResolvedValue(false);

    const props = await renderPage();

    await expect(props.issuedTokensPromise).resolves.toEqual({});
    expect(requestedPaths()).not.toContain("/v1/issuance/tokens?page=1&pageSize=100");
  });

  it("renders the page while the balances are still on their way", async () => {
    const { promise: balances, resolve } = Promise.withResolvers<Response>();
    answering("/v1/payments/wallets/wallet%2Fone/balances", () => balances);

    const props = await renderPage();

    expect(props.wallet.name).toBe("Fast wallet");
    resolve(Response.json({ data: { walletBalances: { balances: [] } } }));
    await expect(props.balancesPromise).resolves.toEqual({ balances: [], error: null });
  });
});
