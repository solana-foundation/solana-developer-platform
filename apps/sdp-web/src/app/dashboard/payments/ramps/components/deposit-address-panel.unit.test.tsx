// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DepositAddressPanel } from "./deposit-address-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { orgId: "org_test", userId: "user_test" },
    selectedProjectId: "proj_test",
    sdpEnvironment: "sandbox",
  }),
}));
vi.mock("qrcode", () => ({
  default: { toDataURL: async () => "data:image/png;base64," },
}));

const signingDisabledWallet: PaymentsDashboardWallet = {
  id: "cwlt_receiving",
  walletId: "privy_receiving",
  publicKey: "4Nd1mYw5Uu7Tq2K8c3JfYb5sXz9Pq3L6vR2hG8aF1eDk",
  label: "Receiving",
  isRuntimeExecutionAllowed: false,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DepositAddressPanel", () => {
  it("shows the address of a wallet that cannot sign, since receiving needs no signature", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      String(input).includes("/transfers")
        ? Response.json({ data: [] })
        : Response.json({ data: { wallets: [signingDisabledWallet] } })
    );

    render(
      <DepositAddressPanel
        wallets={[signingDisabledWallet]}
        walletsError={null}
        issuedTokenSymbolsByMint={{}}
      />,
      { wrapper }
    );

    expect(await screen.findByText(signingDisabledWallet.publicKey)).toBeTruthy();
    expect(screen.getAllByText("Receiving").length).toBeGreaterThan(0);
  });
});
