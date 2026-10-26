// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { PaymentsActionPage as LegacyPaymentsActionPage } from "./ramp-action-page";
import { PaymentsActionPage } from "./ramp-action-page.redesign";

const mocks = vi.hoisted(() => ({ canWrite: true, tab: null as string | null }));

vi.mock("next/navigation", () => import("@/test/next-navigation"));

vi.mock("@/contexts/dashboard-workspace-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/contexts/dashboard-workspace-context")>()),
  useCanWrite: () => mocks.canWrite,
}));

vi.mock("@/lib/dashboard-url-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard-url-state")>()),
  useDashboardTab: () => mocks.tab,
}));

// A provider is configured, so the only thing between a viewer and the on-ramp is the role.
vi.mock("@/lib/provider-availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provider-availability")>()),
  hasEnabledRampProvider: () => true,
}));

vi.mock("./components/deposit-address-panel", () => ({
  DepositAddressPanel: () => <div>address panel</div>,
}));
vi.mock("./onramp-rail.redesign", () => ({ OnrampRail: () => <div>onramp</div> }));
vi.mock("./onchain-receive-rail", () => ({
  OnchainReceiveRail: () => <div>receive by address</div>,
}));

const PROPS: ComponentProps<typeof PaymentsActionPage> = {
  mode: "receive",
  wallets: [],
  walletsError: null,
  issuedTokenSymbolsByMint: {},
  enabledComplianceProviders: [],
  enabledRampProviders: [],
  rampProviderAccess: null,
  counterpartiesResult: { ok: true, data: [] },
};

function renderWith(node: ReactNode) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {node}
    </I18nProvider>
  );
}

beforeEach(() => {
  mocks.canWrite = true;
  mocks.tab = null;
});

afterEach(cleanup);

describe("deposit for a read-only member", () => {
  it("keeps a member's provider tab on the on-ramp", () => {
    mocks.tab = "provider";
    renderWith(<PaymentsActionPage {...PROPS} />);
    expect(screen.getByText("onramp")).toBeTruthy();
  });

  it("shows a viewer the address even on the provider tab", () => {
    mocks.canWrite = false;
    mocks.tab = "provider";
    renderWith(<PaymentsActionPage {...PROPS} />);
    expect(screen.getByText("address panel")).toBeTruthy();
    expect(screen.queryByText("onramp")).toBeNull();
  });

  it("takes a viewer on the previous design straight to the address, past the contact step", () => {
    mocks.canWrite = false;
    renderWith(<LegacyPaymentsActionPage {...PROPS} />);
    expect(screen.getByText("receive by address")).toBeTruthy();
  });

  it("keeps a member on the previous design at the contact step", () => {
    renderWith(<LegacyPaymentsActionPage {...PROPS} />);
    expect(screen.queryByText("receive by address")).toBeNull();
  });
});
