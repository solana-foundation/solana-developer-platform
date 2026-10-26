// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as workspaceContext from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import * as urlState from "@/lib/dashboard-url-state";
import * as providerAvailability from "@/lib/provider-availability";
import * as depositAddressPanel from "./components/deposit-address-panel";
import * as onrampRail from "./onramp-rail";
import { PaymentsActionPage } from "./ramp-action-page";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

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

/** The member's access and the deposit tab the URL names. */
function arrange({ canWrite, tab }: { canWrite: boolean; tab: string | null }) {
  vi.spyOn(workspaceContext, "useCanWrite").mockReturnValue(canWrite);
  vi.spyOn(urlState, "useDashboardTab").mockReturnValue(tab);
}

beforeEach(() => {
  // A provider is configured, so the only thing between a viewer and the on-ramp is the role.
  vi.spyOn(providerAvailability, "hasEnabledRampProvider").mockReturnValue(true);
  // The page picks a rail; each rail has its own suite, so this one only names which it chose.
  vi.spyOn(depositAddressPanel, "DepositAddressPanel").mockImplementation(() => (
    <div>address panel</div>
  ));
  vi.spyOn(onrampRail, "OnrampRail").mockImplementation(() => <div>onramp</div>);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("deposit for a read-only member", () => {
  it("keeps a member's provider tab on the on-ramp", () => {
    arrange({ canWrite: true, tab: "provider" });
    renderWith(<PaymentsActionPage {...PROPS} />);
    expect(screen.getByText("onramp")).toBeTruthy();
  });

  it("shows a viewer the address even on the provider tab", () => {
    arrange({ canWrite: false, tab: "provider" });
    renderWith(<PaymentsActionPage {...PROPS} />);
    expect(screen.getByText("address panel")).toBeTruthy();
    expect(screen.queryByText("onramp")).toBeNull();
  });
});
