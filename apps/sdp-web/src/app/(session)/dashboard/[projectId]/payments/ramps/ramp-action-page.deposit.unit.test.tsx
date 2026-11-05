// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as workspaceContext from "@/contexts/dashboard-workspace-context";
import * as urlState from "@/lib/dashboard-url-state";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  readsOf,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import { EnglishDashboardReads } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import * as depositAddressPanel from "./components/deposit-address-panel";
import * as offrampRail from "./offramp-rail";
import * as onchainSendRail from "./onchain-send-rail";
import * as onrampRail from "./onramp-rail";
import { PaymentsActionPage } from "./ramp-action-page";
import * as rampsOffered from "./use-ramps-offered";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const PROVIDER_ACCESS_PATH = "/api/dashboard/organizations/current/provider-access";
const INSTANCE_PATH = "/api/dashboard/private-channels/instance";
const NO_PROVIDER = "No card or bank provider is enabled for this project yet.";

const DEPOSIT: ComponentProps<typeof PaymentsActionPage> = {
  mode: "receive",
  enabledRampProviders: ["moonpay"],
  issuanceEnabled: false,
};
const PAY: ComponentProps<typeof PaymentsActionPage> = { ...DEPOSIT, mode: "send" };

const ACTIVE_INSTANCE = {
  id: "pci_test",
  organizationId: "org_test",
  projectId: SANDBOX_PROJECT.id,
  isActive: true,
  createdBy: null,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  gatewayUrl: "https://gateway.test",
  chainRpcUrl: "https://rpc.test",
  escrowProgramId: "escrow_program_test",
  withdrawProgramId: "withdraw_program_test",
  escrowInstanceAddr: "escrow_instance_test",
  authUrl: "https://auth.test",
};

type ProviderAccessAnswer = "granted" | "failed";

let instanceAnswer: () => Response;

function stubReads(access: ProviderAccessAnswer) {
  return stubDashboardFetch(({ path }) => {
    if (path === PROVIDER_ACCESS_PATH) {
      return access === "granted"
        ? dashboardDataResponse(200, {
            providers: {
              ramps: { moonpay: { entitled: true, configured: true, enabled: true } },
              earn: {},
            },
          })
        : dashboardErrorResponse(503, "Provider access is unavailable");
    }
    if (path === INSTANCE_PATH) {
      return instanceAnswer();
    }
    return dashboardDataResponse(200, { counterparties: [], total: 0, page: 1, pageSize: 100 });
  });
}

/** The member's access and the tab the URL names. */
function arrange({ canWrite, tab }: { canWrite: boolean; tab: string | null }) {
  vi.spyOn(workspaceContext, "useCanWrite").mockReturnValue(canWrite);
  vi.spyOn(urlState, "useDashboardTab").mockReturnValue(tab);
}

function openPayByBank() {
  const url = `/dashboard/${SANDBOX_PROJECT.id}/payments/pay?counterpartyId=cpty_test&method=bank`;
  setDashboardUrl(url, {});
  setWindowPathname(url);
}

beforeEach(() => {
  resetDashboardNavigation();
  instanceAnswer = () => dashboardErrorResponse(503, "Instance is unavailable");
  vi.spyOn(rampsOffered, "useRampsOffered").mockReturnValue(true);
  vi.spyOn(depositAddressPanel, "DepositAddressPanel").mockImplementation(() => (
    <div>address panel</div>
  ));
  vi.spyOn(onrampRail, "OnrampRail").mockImplementation(() => <div>onramp</div>);
  vi.spyOn(offrampRail, "OfframpRail").mockImplementation(() => <div>offramp</div>);
  vi.spyOn(onchainSendRail, "OnchainSendRail").mockImplementation(
    ({ onPayByBank, privateSend }) => (
      <div>
        <p>{`bank:${onPayByBank !== undefined}`}</p>
        <p>{`private:${JSON.stringify(privateSend)}`}</p>
      </div>
    )
  );
});

afterEach(() => {
  cleanup();
  restoreWindowLocation();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("deposit for a read-only member", () => {
  it("keeps a member's provider tab on the on-ramp", async () => {
    stubReads("granted");
    arrange({ canWrite: true, tab: "provider" });
    render(<PaymentsActionPage {...DEPOSIT} />, { wrapper: EnglishDashboardReads });
    expect(await screen.findByText("onramp")).toBeTruthy();
  });

  it("shows a viewer the address even on the provider tab", async () => {
    stubReads("granted");
    arrange({ canWrite: false, tab: "provider" });
    render(<PaymentsActionPage {...DEPOSIT} />, { wrapper: EnglishDashboardReads });
    expect(await screen.findByText("address panel")).toBeTruthy();
    expect(screen.queryByText("onramp")).toBeNull();
  });
});

describe("deposit where the channel runs no Ramps", () => {
  it("opens the address on a stale provider tab, with no provider notice", async () => {
    stubReads("granted");
    vi.spyOn(rampsOffered, "useRampsOffered").mockReturnValue(false);
    arrange({ canWrite: true, tab: "provider" });
    render(<PaymentsActionPage {...DEPOSIT} />, { wrapper: EnglishDashboardReads });
    expect(await screen.findByText("address panel")).toBeTruthy();
    expect(screen.queryByText("onramp")).toBeNull();
    expect(screen.queryByText(NO_PROVIDER)).toBeNull();
  });
});

describe("provider access", () => {
  it.each<[string, ProviderAccessAnswer, ComponentProps<typeof PaymentsActionPage>, string]>([
    ["Deposit", "granted", DEPOSIT, "onramp"],
    ["Deposit", "failed", DEPOSIT, NO_PROVIDER],
    ["Pay by bank", "granted", PAY, "offramp"],
    ["Pay by bank", "failed", PAY, "bank:false"],
  ])(
    "opens %s on a %s provider access read, and on nothing before it answers",
    async (_flow, access, props, shown) => {
      stubReads(access);
      arrange({ canWrite: true, tab: props.mode === "receive" ? "provider" : null });
      if (props.mode === "send") {
        openPayByBank();
      }
      render(<PaymentsActionPage {...props} />, { wrapper: EnglishDashboardReads });

      expect(screen.queryByText(shown)).toBeNull();
      expect(await screen.findByText(shown)).toBeTruthy();
    }
  );
});

describe("Pay's private send status", () => {
  it.each<[string, boolean, () => Response, string]>([
    ["off", false, () => dashboardDataResponse(200, { instance: ACTIVE_INSTANCE }), "null"],
    [
      "on with an active instance",
      true,
      () => dashboardDataResponse(200, { instance: ACTIVE_INSTANCE }),
      JSON.stringify({ enabled: true, connected: true }),
    ],
    [
      "on with a failed instance read",
      true,
      () => dashboardErrorResponse(503, "Instance is unavailable"),
      JSON.stringify({ enabled: true, connected: false }),
    ],
  ])("reports Private Channels %s", async (_state, enabled, answer, status) => {
    instanceAnswer = answer;
    const fetchMock = stubReads("granted");
    arrange({ canWrite: true, tab: null });
    render(<PaymentsActionPage {...PAY} privateChannelsEnabled={enabled} />, {
      wrapper: EnglishDashboardReads,
    });

    expect(await screen.findByText(`private:${status}`)).toBeTruthy();
    expect(readsOf(fetchMock, INSTANCE_PATH) > 0).toBe(enabled);
  });
});
