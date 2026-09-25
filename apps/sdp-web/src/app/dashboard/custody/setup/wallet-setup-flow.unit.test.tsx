// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeScopeProvider } from "@/components/theme-scope-provider";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  createWallet: vi.fn(async (_formData: FormData) => ({ status: "success" as const })),
  initialize: vi.fn(async (_formData: FormData) => ({ status: "success" as const })),
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { userId: "user_test", orgId: "org_test" },
    selectedProjectId: "project_test",
    projects: [{ id: "project_test", name: "Default Sandbox Project" }],
    sdpEnvironment: "sandbox",
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/app/dashboard/custody/actions", () => ({
  createCustodySetupWalletAction: mocks.createWallet,
  initializeCustodySetupAction: mocks.initialize,
}));
vi.mock("@/app/dashboard/custody/use-wallet-inventory-refresh", () => ({
  useWalletInventoryRefresh: () => () => undefined,
}));

const { WalletSetupFlow } = await import("./wallet-setup-flow");

type FlowProps = Parameters<typeof WalletSetupFlow>[0];

function renderFlow(props: Partial<FlowProps> = {}) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ThemeScopeProvider scope="refresh">
        <WalletSetupFlow
          connectedProviders={props.connectedProviders ?? ["turnkey"]}
          enabledProviders={props.enabledProviders ?? ["turnkey", "privy"]}
          initialProvider={props.initialProvider ?? null}
          privyByokEnabled={props.privyByokEnabled}
          connections={props.connections}
        />
      </ThemeScopeProvider>
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("provider step", () => {
  it("lists usable providers as radios and the rest as not ready or to set up", () => {
    renderFlow({ connectedProviders: ["turnkey"], enabledProviders: ["turnkey", "dfns"] });

    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Which provider holds the keys?" })).toBeTruthy();
    const list = document.querySelector("[data-wallet-provider-list]") as HTMLElement;
    const names = [...list.querySelectorAll("[data-wallet-provider]")].map((row) =>
      row.getAttribute("data-wallet-provider")
    );
    // Connected first, then ready to install, then the general providers without credentials.
    expect(names.slice(0, 2)).toEqual(["turnkey", "dfns"]);
    const privy = within(list).getByRole("radio", { name: /Privy/ }) as HTMLInputElement;
    expect(privy.disabled).toBe(true);
    expect(within(list).getAllByText("Not ready").length).toBeGreaterThan(0);
    expect(names).not.toContain("local");

    const setUp = document.querySelector("[data-wallet-provider-setup-list]") as HTMLElement;
    expect(within(setUp).getByText("Not set up yet")).toBeTruthy();
    expect(within(setUp).getByRole("link", { name: "Set up Anchorage" }).getAttribute("href")).toBe(
      "/dashboard/integrations/anchorage"
    );
    // A manual provider the organization already has access to is a choice, not a set-up row.
    expect(within(setUp).queryByText("DFNS")).toBeNull();
  });

  it("continues only once a provider is chosen", () => {
    renderFlow();
    const continueButton = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /Turnkey/ }));
    expect(continueButton.disabled).toBe(false);
    fireEvent.click(continueButton);
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Wallet details" })).toBeTruthy();
  });

  it("advances with Enter from the chosen radio without creating anything", () => {
    renderFlow();
    const turnkey = screen.getByRole("radio", { name: /Turnkey/ });
    fireEvent.click(turnkey);
    fireEvent.keyDown(turnkey, { key: "Enter" });
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();
    expect(mocks.createWallet).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
  });

  it("explains why nothing can be chosen instead of emptying the page", () => {
    renderFlow({ connectedProviders: [], enabledProviders: [] });
    // Every general provider still shows, not ready, so the organization sees what exists.
    expect(screen.getByRole("radio", { name: /Turnkey/ })).toBeTruthy();
    expect(screen.getByText("Anchorage")).toBeTruthy();
  });

  it("leaves for the wallet list from Cancel", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.push).toHaveBeenCalledWith("/dashboard/wallets");
  });
});

describe("details step", () => {
  it("states what the wallet is created with and goes back to change the provider", () => {
    renderFlow({ initialProvider: "turnkey" });

    const createdWith = screen.getByRole("region", { name: "Created with" });
    expect(within(createdWith).getByText("Turnkey")).toBeTruthy();
    expect(within(createdWith).getByText("Default Sandbox Project")).toBeTruthy();
    expect(within(createdWith).getByText("Sandbox · devnet")).toBeTruthy();
    expect(screen.getByText("Turnkey creates the keys when you confirm.")).toBeTruthy();

    fireEvent.click(within(createdWith).getByRole("button", { name: "Change" }));
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Turnkey/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("creates an additional wallet with its label and purpose, then returns to the list", async () => {
    renderFlow({ initialProvider: "turnkey" });
    const create = screen.getByRole("button", { name: "Create wallet" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Wallet label"), {
      target: { value: "Settlement wallet" },
    });
    expect(create.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(create);
    });

    const formData = mocks.createWallet.mock.calls[0]?.[0] as FormData;
    expect(formData.get("provider")).toBe("turnkey");
    expect(formData.get("label")).toBe("Settlement wallet");
    expect(formData.get("purpose")).toBe("root");
    expect(mocks.push).toHaveBeenCalledWith("/dashboard/wallets");
  });

  it("fixes the first wallet on a provider as its root wallet", async () => {
    renderFlow({
      connectedProviders: [],
      enabledProviders: ["turnkey"],
      initialProvider: "turnkey",
    });
    expect(screen.getByRole("button", { name: /first wallet is its root wallet/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Wallet label"), { target: { value: "Treasury" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));
    });
    const formData = mocks.initialize.mock.calls[0]?.[0] as FormData;
    expect(formData.get("walletLabel")).toBe("Treasury");
    expect(formData.get("purpose")).toBeNull();
  });

  it("shows the API's refusal and stays on the step", async () => {
    mocks.createWallet.mockResolvedValueOnce({
      status: "error",
      message: "Provider rejected the request",
    } as never);
    renderFlow({ initialProvider: "turnkey" });
    fireEvent.change(screen.getByLabelText("Wallet label"), { target: { value: "Ops" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Provider rejected the request");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("Privy stored credentials", () => {
  it("keeps the wallet details for privy while the BYOK flag is off", () => {
    renderFlow({
      connectedProviders: ["privy"],
      enabledProviders: ["privy"],
      initialProvider: "privy",
    });
    expect(screen.getByRole("heading", { name: "Wallet details" })).toBeTruthy();
    expect(document.querySelector("[data-privy-byok-form]")).toBeNull();
  });

  it("sends an uninstalled privy to provider details when BYOK is on", () => {
    renderFlow({
      connectedProviders: [],
      enabledProviders: ["privy"],
      initialProvider: "privy",
      privyByokEnabled: true,
    });
    expect(screen.getByRole("heading", { name: "Provider details" })).toBeTruthy();
    expect(document.querySelector("[data-privy-byok-form]")).toBeTruthy();
    // The credential form owns its submit; the footer offers no second one.
    expect(screen.queryByRole("button", { name: "Create wallet" })).toBeNull();
  });
});

describe("connection picker", () => {
  function connection(
    overrides: Partial<FlowProps["connections"] extends (infer T)[] | undefined ? T : never> = {}
  ) {
    return {
      id: "conn-active",
      provider: "privy" as const,
      label: "Production signing",
      status: "active" as const,
      isDefault: false,
      isRuntimeExecutionAllowed: true,
      defaultCustodyWalletId: null,
      createdAt: "2026-08-10T09:00:00.000Z",
      activatedAt: "2026-08-10T09:05:00.000Z",
      lastCheck: null,
      pendingWalletLabel: null,
      ...overrides,
    };
  }

  function renderInstalledPrivy(
    connections: FlowProps["connections"],
    connectedProviders: FlowProps["connectedProviders"] = ["privy"]
  ) {
    return renderFlow({
      connectedProviders,
      enabledProviders: ["privy"],
      initialProvider: "privy",
      privyByokEnabled: true,
      connections,
    });
  }

  const pickerValue = () =>
    (document.querySelector('input[name="connectionId"]') as HTMLInputElement | null)?.value;

  it("offers the connection once the project has a usable one", () => {
    renderInstalledPrivy([connection()]);
    expect(screen.getByText("Connection")).toBeTruthy();
    expect(pickerValue()).toBe("conn-active");
  });

  it("preselects the project default over the first connection", () => {
    renderInstalledPrivy([
      connection({ id: "conn-first" }),
      connection({ id: "conn-default", isDefault: true }),
    ]);
    expect(pickerValue()).toBe("conn-default");
  });

  it("stays out of the way when nothing is selectable", () => {
    renderInstalledPrivy([connection({ status: "pending" })]);
    expect(pickerValue()).toBeUndefined();
    expect(screen.getByRole("heading", { name: "Wallet details" })).toBeTruthy();
  });

  // A BYOK-only project has no legacy config, so `/v1/wallets/configs` reports
  // nothing connected; the active connection alone must mark privy installed.
  it("offers an active connection when there is no legacy config", () => {
    renderInstalledPrivy([connection({ isDefault: false })], []);
    expect(pickerValue()).toBe("conn-active");
    expect(document.querySelector('input[name="label"]')).toBeTruthy();
    expect(document.querySelector("[data-privy-byok-form]")).toBeNull();
  });

  it("keeps the credential form while the only connection is not active yet", () => {
    renderInstalledPrivy([connection({ status: "pending" })], []);
    expect(document.querySelector("[data-privy-byok-form]")).toBeTruthy();
    expect(pickerValue()).toBeUndefined();
  });

  // Connections belong to one provider; switching on step 1 must not carry them over.
  it("ignores connections belonging to another provider", () => {
    renderFlow({
      connectedProviders: ["fireblocks"],
      enabledProviders: ["fireblocks"],
      initialProvider: "fireblocks",
      connections: [connection()],
    });
    expect(pickerValue()).toBeUndefined();
  });
});
