// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCustodySetupWalletAction,
  initializeCustodySetupAction,
} from "@/app/dashboard/[projectId]/custody/actions";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { availableCustodyProviders } from "@/lib/provider-availability";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { WalletSetupFlow } from "./wallet-setup-flow";

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { userId: "user_test", orgId: "org_test" },
    selectedProjectId: "project_test",
  }),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));

vi.mock("@/app/dashboard/[projectId]/custody/actions", () => ({
  createCustodySetupWalletAction: vi.fn(),
  initializeCustodySetupAction: vi.fn(),
}));

type FlowProps = Parameters<typeof WalletSetupFlow>[0];
type ConnectionItem = FlowProps["connections"][number];

beforeEach(() => {
  vi.mocked(createCustodySetupWalletAction).mockReset();
  vi.mocked(initializeCustodySetupAction).mockReset();
});

afterEach(() => {
  cleanup();
  resetDashboardNavigation();
});

const SANDBOX_AVAILABILITY = availableCustodyProviders(
  projectProviderAvailability({
    project: SANDBOX_PROJECT,
    custody: [
      { provider: "privy", modes: ["managed", "byok"] },
      { provider: "fireblocks", modes: ["managed"] },
    ],
    compliance: [],
    ramps: [],
    earn: [],
  })
);

const SANDBOX_MANAGED_PRIVY_AVAILABILITY = availableCustodyProviders(
  projectProviderAvailability({
    project: SANDBOX_PROJECT,
    custody: [{ provider: "privy", modes: ["managed"] }],
    compliance: [],
    ramps: [],
    earn: [],
  })
);

const PRODUCTION_AVAILABILITY = availableCustodyProviders(
  projectProviderAvailability({
    project: PRODUCTION_PROJECT,
    custody: [{ provider: "privy", modes: ["byok"] }],
    compliance: [],
    ramps: [],
    earn: [],
  })
);

const SANDBOX_FLOW: FlowProps = {
  connectedProviders: ["privy"],
  custodyAvailability: SANDBOX_AVAILABILITY,
  environment: "sandbox",
  initialProvider: null,
  connections: [],
};

const PRODUCTION_FLOW: FlowProps = {
  connectedProviders: [],
  custodyAvailability: PRODUCTION_AVAILABILITY,
  environment: "production",
  initialProvider: null,
  connections: [],
};

function renderInteractiveFlow(props: FlowProps) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletSetupFlow {...props} />
    </I18nProvider>
  );
}

function submittedWalletForm(): FormData {
  const call = vi.mocked(createCustodySetupWalletAction).mock.lastCall;
  if (!call) {
    throw new Error("Expected a wallet submission");
  }
  return call[0];
}

function renderFlow(props: FlowProps): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletSetupFlow {...props} />
    </I18nProvider>
  );
}

function detailsSubmitButton(markup: string): string {
  const match = markup.match(/<button[^>]*form="wallet-details-form"[^>]*>/);
  if (match === null) {
    throw new Error("expected a wallet details submit button");
  }
  return match[0];
}

function connection(overrides: Partial<ConnectionItem>): ConnectionItem {
  return {
    id: "conn-active",
    provider: "privy",
    label: "Production signing",
    status: "active",
    isRuntimeExecutionAllowed: true,
    createdAt: "2026-08-10T09:00:00.000Z",
    activatedAt: "2026-08-10T09:05:00.000Z",
    lastCheck: null,
    pendingWalletLabel: null,
    ...overrides,
  };
}

describe("WalletSetupFlow", () => {
  it("keeps an installed provider on the additional-wallet path without a mode choice", () => {
    const markup = renderFlow({ ...SANDBOX_FLOW, initialProvider: "privy" });

    expect(markup).toContain("Wallet details");
    expect(markup).not.toContain("data-privy-byok-form");
    expect(markup).not.toContain('aria-label="Custody mode"');
  });

  it("uses the shared top progress and bottom action layout for provider selection", () => {
    const markup = renderFlow(SANDBOX_FLOW);

    expect(markup.match(/data-wallet-setup-stepper="true"/g)).toHaveLength(1);
    expect(markup).toContain("Step 1 of 2");
    expect(markup.match(/data-wallet-setup-scroll-region="true"/g)).toHaveLength(1);
    expect(markup.match(/data-wallet-setup-actions="true"/g)).toHaveLength(1);
    expect(markup.indexOf('data-wallet-setup-stepper="true"')).toBeLessThan(
      markup.indexOf('data-wallet-setup-scroll-region="true"')
    );
    expect(markup.indexOf('data-wallet-setup-scroll-region="true"')).toBeLessThan(
      markup.indexOf('data-wallet-setup-actions="true"')
    );
    expect(markup).not.toContain("bg-white/95");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Next");
    expect(markup).toContain('id="wallet-provider-form"');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*form="wallet-provider-form"/);
    expect(markup.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(markup).not.toContain("data-wallet-enter-advance");
  });

  it("keeps wallet details in the same shell with back and create actions", () => {
    const markup = renderFlow({ ...SANDBOX_FLOW, initialProvider: "privy" });

    expect(markup).toContain("Step 2 of 2");
    expect(markup).toContain('id="wallet-details-form"');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*form="wallet-details-form"/);
    expect(markup).toContain("Wallet details");
    expect(markup).toContain(">Back<");
    expect(markup).toContain("Create wallet");
    expect(markup.match(/data-wallet-setup-actions="true"/g)).toHaveLength(1);
  });

  it("shows only the providers the project can use", () => {
    const markup = renderFlow({ ...SANDBOX_FLOW, connectedProviders: [] });

    expect(markup.match(/data-provider-selection-card="true"/g)).toHaveLength(2);
    expect(markup).toContain("Privy");
    expect(markup).toContain("Fireblocks");
    for (const label of ["Turnkey", "Anchorage", "IBM Digital Asset Haven", "Local Signer"]) {
      expect(markup).not.toContain(label);
    }
    expect(markup).not.toContain('data-provider-selectable="false"');
  });

  it("groups the available providers by what they are for", () => {
    const markup = renderFlow({ ...SANDBOX_FLOW, connectedProviders: [] });

    expect(markup).toMatch(/<h3[^>]*>API<\/h3>/);
    expect(markup).toMatch(/<h3[^>]*>Institutional<\/h3>/);
    expect(markup).toContain(
      "Wallet infrastructure for API-driven product, operations, and automated flows."
    );
  });

  it("tells the user to add a wallet when the provider is already set up", async () => {
    vi.mocked(initializeCustodySetupAction).mockResolvedValue({
      status: "provider_already_set_up",
    });
    const user = userEvent.setup();
    renderInteractiveFlow({
      ...SANDBOX_FLOW,
      connectedProviders: [],
      custodyAvailability: SANDBOX_MANAGED_PRIVY_AVAILABILITY,
      initialProvider: "privy",
    });

    await user.type(screen.getByLabelText("Wallet label"), "Treasury");
    await user.click(screen.getByRole("button", { name: "Create wallet" }));

    expect(
      await screen.findByText("This provider is already set up. Add a wallet instead.")
    ).toBeTruthy();
    expect(initializeCustodySetupAction).toHaveBeenCalledTimes(1);
    expect(dashboardRouter.push).not.toHaveBeenCalled();
  });

  it("explains why nothing can be selected when the project can use no provider", () => {
    const markup = renderFlow({ ...SANDBOX_FLOW, connectedProviders: [], custodyAvailability: [] });

    expect(markup).toContain(
      "Wallet creation is available after a custody provider is enabled for this organization."
    );
    expect(markup).not.toContain("data-provider-selection-card");
    expect(markup).not.toContain("<h3");
  });
});

describe("WalletSetupFlow custody mode", () => {
  it("offers only Privy in Production", () => {
    const markup = renderFlow(PRODUCTION_FLOW);

    expect(markup.match(/data-provider-selection-card="true"/g)).toHaveLength(1);
    expect(markup).toContain("Privy");
    expect(markup).not.toContain("Fireblocks");
  });

  it("sends Privy straight to provider details in Production, with no Managed option", () => {
    const markup = renderFlow({ ...PRODUCTION_FLOW, initialProvider: "privy" });

    expect(markup).toContain("Provider details");
    expect(markup).toContain("data-privy-byok-form");
    expect(markup).toMatch(/type="password"/);
    expect(markup).not.toContain('aria-label="Custody mode"');
    expect(markup).not.toContain(">Managed<");
    expect(markup).not.toContain('id="wallet-details-form"');
    expect(markup).not.toContain("Create wallet");
  });

  it("labels a Production wallet's environment as Production", () => {
    const markup = renderFlow({
      ...PRODUCTION_FLOW,
      initialProvider: "privy",
      connections: [connection({})],
    });

    expect(markup).toContain("Wallet details");
    expect(markup).toContain(">Production<");
    expect(markup).not.toContain(">Sandbox<");
  });

  it("asks a Sandbox project to choose a mode for a provider offering both, with nothing preselected", () => {
    const markup = renderFlow({
      ...SANDBOX_FLOW,
      connectedProviders: [],
      initialProvider: "privy",
    });

    expect(markup).toContain('aria-label="Custody mode"');
    expect(markup).toContain("Choose a custody mode");
    expect(markup).not.toContain("data-privy-byok-form");
    expect(markup).not.toContain('id="wallet-label"');
  });

  it("blocks submitting until a mode is chosen", () => {
    const markup = renderFlow({
      ...SANDBOX_FLOW,
      connectedProviders: [],
      initialProvider: "privy",
    });

    expect(markup).not.toContain('id="wallet-details-form"');
    expect(detailsSubmitButton(markup)).toContain('disabled=""');
  });

  it("skips the mode choice for a provider offering one mode", () => {
    const markup = renderFlow({
      ...SANDBOX_FLOW,
      connectedProviders: [],
      initialProvider: "fireblocks",
    });

    expect(markup).not.toContain('aria-label="Custody mode"');
    expect(markup).not.toContain("data-privy-byok-form");
    expect(markup).toContain('id="wallet-details-form"');
    expect(markup).toContain(">Sandbox<");
    expect(detailsSubmitButton(markup)).not.toContain('disabled=""');
  });
});

describe("WalletSetupFlow connection picker", () => {
  function renderInstalledPrivy(
    props: Pick<FlowProps, "connections" | "connectedProviders">
  ): string {
    return renderFlow({ ...SANDBOX_FLOW, ...props, initialProvider: "privy" });
  }

  it("offers the account picker once the project has a usable connection", () => {
    const markup = renderInstalledPrivy({
      connections: [connection({})],
      connectedProviders: ["privy"],
    });

    expect(markup).toContain("The wallet is created in this account");
    expect(markup).toContain('name="walletTarget"');
  });

  it("preselects no account, even when only one is selectable", () => {
    const markup = renderInstalledPrivy({
      connections: [connection({ id: "conn-only" })],
      connectedProviders: [],
    });

    expect(markup).toContain('name="walletTarget"');
    expect(markup).not.toContain("conn-only");
  });

  function renderInteractiveInstalledPrivy() {
    return renderInteractiveFlow({
      ...SANDBOX_FLOW,
      connectedProviders: ["privy"],
      initialProvider: "privy",
      connections: [connection({})],
    });
  }

  it("refuses to submit until the user picks the account", async () => {
    const user = userEvent.setup();
    renderInteractiveInstalledPrivy();

    await user.type(screen.getByLabelText("Wallet label"), "Treasury");
    await user.click(screen.getByRole("button", { name: "Create wallet" }));

    expect(await screen.findByText("Choose the account the wallet is created in.")).toBeTruthy();
    expect(createCustodySetupWalletAction).not.toHaveBeenCalled();
  });

  it("names the provider and no connection when Managed is picked", async () => {
    vi.mocked(createCustodySetupWalletAction).mockResolvedValue({ status: "success" });
    const user = userEvent.setup();
    renderInteractiveInstalledPrivy();

    await user.type(screen.getByLabelText("Wallet label"), "Treasury");
    await user.click(screen.getByRole("combobox", { name: "Account" }));
    await user.click(await screen.findByRole("option", { name: "Managed by SDP" }));
    await user.click(screen.getByRole("button", { name: "Create wallet" }));

    await waitFor(() => expect(createCustodySetupWalletAction).toHaveBeenCalledTimes(1));
    const formData = submittedWalletForm();
    expect(formData.get("provider")).toBe("privy");
    expect(formData.get("connectionId")).toBeNull();
  });

  it("names the picked connection", async () => {
    vi.mocked(createCustodySetupWalletAction).mockResolvedValue({ status: "success" });
    const user = userEvent.setup();
    renderInteractiveInstalledPrivy();

    await user.type(screen.getByLabelText("Wallet label"), "Treasury");
    await user.click(screen.getByRole("combobox", { name: "Account" }));
    await user.click(await screen.findByRole("option", { name: "Production signing" }));
    await user.click(screen.getByRole("button", { name: "Create wallet" }));

    await waitFor(() => expect(createCustodySetupWalletAction).toHaveBeenCalledTimes(1));
    expect(submittedWalletForm().get("connectionId")).toBe("conn-active");
  });

  it("stays out of the way when nothing is selectable", () => {
    const markup = renderInstalledPrivy({
      connections: [connection({ status: "pending" })],
      connectedProviders: ["privy"],
    });

    expect(markup).not.toContain("The wallet is created in this account");
    expect(markup).toContain("Wallet details");
  });

  it("stays out of the way when the project has no connections at all", () => {
    const markup = renderInstalledPrivy({ connections: [], connectedProviders: ["privy"] });

    expect(markup).not.toContain("The wallet is created in this account");
  });

  it("offers an active connection when there is no managed config", () => {
    const markup = renderInstalledPrivy({
      connections: [connection({})],
      connectedProviders: [],
    });

    expect(markup).toContain("Wallet details");
    expect(markup).toContain('name="walletTarget"');
    expect(markup).toContain('name="label"');
    expect(markup).not.toContain('aria-label="Custody mode"');
    expect(markup).not.toContain("data-privy-byok-form");
    expect(markup).not.toMatch(/type="password"/);
  });

  it("keeps the credential form while the only connection is not active yet", () => {
    const markup = renderFlow({
      ...PRODUCTION_FLOW,
      initialProvider: "privy",
      connections: [connection({ status: "pending" })],
    });

    expect(markup).toContain("data-privy-byok-form");
    expect(markup).not.toContain('name="walletTarget"');
  });

  it("offers no connections for a provider whose modes leave out byok", () => {
    const managedOnly = availableCustodyProviders(
      projectProviderAvailability({
        project: SANDBOX_PROJECT,
        custody: [{ provider: "privy", modes: ["managed"] }],
        compliance: [],
        ramps: [],
        earn: [],
      })
    );
    const markup = renderFlow({
      ...SANDBOX_FLOW,
      custodyAvailability: managedOnly,
      initialProvider: "privy",
      connections: [connection({})],
    });

    expect(markup).toContain("Wallet details");
    expect(markup).not.toContain("The wallet is created in this account");
    expect(markup).not.toContain('name="walletTarget"');
  });

  it("ignores connections belonging to another provider", () => {
    const markup = renderFlow({
      ...SANDBOX_FLOW,
      connectedProviders: ["fireblocks"],
      initialProvider: "fireblocks",
      connections: [connection({})],
    });

    expect(markup).not.toContain("The wallet is created in this account");
  });
});
