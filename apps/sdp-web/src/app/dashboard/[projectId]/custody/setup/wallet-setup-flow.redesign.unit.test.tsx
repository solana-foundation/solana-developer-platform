// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeScopeProvider } from "@/components/theme-scope-provider";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { availableCustodyProviders } from "@/lib/provider-availability";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";

const mocks = vi.hoisted(() => ({
  projectId: "prj_test_sandbox",
  createWallet: vi.fn(async (_formData: FormData) => ({ status: "success" as const })),
  initialize: vi.fn(async (_formData: FormData) => ({ status: "success" as const })),
  refreshWalletInventory: vi.fn(),
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { userId: "user_test", orgId: "org_test" },
    selectedProjectId: mocks.projectId,
    projects: [{ id: "prj_test_sandbox", name: "Default Sandbox Project" }],
    sdpEnvironment: "sandbox",
  }),
}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/app/dashboard/[projectId]/custody/actions", () => ({
  createCustodySetupWalletAction: mocks.createWallet,
  initializeCustodySetupAction: mocks.initialize,
}));
vi.mock("@/app/dashboard/[projectId]/custody/byok-actions", () => ({
  submitPrivyCredentialAction: vi.fn(),
  recheckPrivyCredentialAction: vi.fn(),
}));
vi.mock("@/app/dashboard/[projectId]/custody/use-wallet-inventory-refresh", () => ({
  useWalletInventoryRefresh: () => mocks.refreshWalletInventory,
}));

const { WalletSetupFlow } = await import("./wallet-setup-flow.redesign");

type FlowProps = Parameters<typeof WalletSetupFlow>[0];
type ConnectionItem = FlowProps["connections"][number];

const SANDBOX_AVAILABILITY = availableCustodyProviders(
  projectProviderAvailability({
    project: SANDBOX_PROJECT,
    custody: [
      { provider: "turnkey", modes: ["managed"] },
      { provider: "dfns", modes: ["managed"] },
      { provider: "privy", modes: ["managed", "byok"] },
    ],
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

function renderFlow(props: Partial<FlowProps> = {}) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ThemeScopeProvider scope="refresh">
        <WalletSetupFlow
          connectedProviders={props.connectedProviders ?? ["turnkey"]}
          custodyAvailability={props.custodyAvailability ?? SANDBOX_AVAILABILITY}
          environment={props.environment ?? "sandbox"}
          initialProvider={props.initialProvider ?? null}
          connections={props.connections ?? []}
        />
      </ThemeScopeProvider>
    </I18nProvider>
  );
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.projectId = "prj_test_sandbox";
});

describe("provider step", () => {
  it("lists the providers the project can use as radios, connected first", () => {
    renderFlow({ connectedProviders: ["dfns"] });

    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Which provider holds the keys?" })).toBeTruthy();
    const list = document.querySelector("[data-wallet-provider-list]") as HTMLElement;
    const names = [...list.querySelectorAll("[data-wallet-provider]")].map((row) =>
      row.getAttribute("data-wallet-provider")
    );
    expect(names[0]).toBe("dfns");
    expect(new Set(names)).toEqual(new Set(["turnkey", "dfns", "privy"]));
    for (const radio of within(list).getAllByRole("radio")) {
      expect((radio as HTMLInputElement).disabled).toBe(false);
    }
    expect(within(list).getAllByText("Active")).toHaveLength(1);
  });

  it("hides a provider the project cannot use, rather than showing it disabled", () => {
    renderFlow({ custodyAvailability: PRODUCTION_AVAILABILITY, environment: "production" });

    const list = document.querySelector("[data-wallet-provider-list]") as HTMLElement;
    expect(within(list).getAllByRole("radio")).toHaveLength(1);
    expect(screen.queryByRole("radio", { name: /Turnkey/ })).toBeNull();
    expect(screen.queryByText("Not ready")).toBeNull();
    expect(document.querySelector("[data-wallet-provider-setup-list]")).toBeNull();
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

  it("says so when the project can use no provider, instead of emptying the page", () => {
    renderFlow({ connectedProviders: [], custodyAvailability: [] });
    expect(
      screen.getByText(
        "Wallet creation is available after a custody provider is enabled for this organization."
      )
    ).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("leaves for the project's wallet list from Cancel", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dashboardRouter.push).toHaveBeenCalledWith("/dashboard/prj_test_sandbox/wallets");
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
    expect(dashboardRouter.push).toHaveBeenCalledWith("/dashboard/prj_test_sandbox/wallets");
  });

  it("fixes the first wallet on a provider as its root wallet", async () => {
    renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
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
    expect(dashboardRouter.push).not.toHaveBeenCalled();
  });

  // Jina (#2333): an uncertain or refused setup left the wallet inventory as it
  // was, so a wallet an earlier attempt created did not show up before a retry.
  it("refreshes the wallet inventory after an uncertain or refused setup and points to the list", async () => {
    mocks.initialize.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
    fireEvent.change(screen.getByLabelText("Wallet label"), { target: { value: "Unsure" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));
    });
    expect(mocks.refreshWalletInventory).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toMatch(/Check your wallet list first/);

    mocks.initialize.mockResolvedValueOnce({
      status: "error",
      message: "Provider rejected the request",
    } as never);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));
    });
    expect(mocks.refreshWalletInventory).toHaveBeenCalledTimes(2);
    expect(dashboardRouter.push).not.toHaveBeenCalled();
  });

  it("keeps the form and the key when the answer is lost, so Create wallet again resends the same key", async () => {
    mocks.initialize.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
    fireEvent.change(screen.getByLabelText("Wallet label"), {
      target: { value: "Lost answer treasury" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(
      /couldn't confirm whether the wallet was created/
    );
    expect(dashboardRouter.push).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));
    });
    const [first, retry] = mocks.initialize.mock.calls.map(([form]) => form);
    expect(first?.get("idempotencyKey")).toEqual(expect.any(String));
    expect(retry?.get("idempotencyKey")).toBe(first?.get("idempotencyKey"));
    expect(mocks.createWallet).not.toHaveBeenCalled();
    expect(dashboardRouter.push).toHaveBeenCalledWith("/dashboard/prj_test_sandbox/wallets");
  });

  it("gives the same setup in another project its own key, so it never settles this one's", async () => {
    mocks.initialize.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const submit = async () => {
      renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
      fireEvent.change(screen.getByLabelText("Wallet label"), {
        target: { value: "Per-project treasury" },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));
      });
      cleanup();
    };

    await submit();
    mocks.projectId = "prj_test_other";
    await submit();

    const [inSandbox, inOther] = mocks.initialize.mock.calls.map(([form]) => form);
    expect(inSandbox?.get("idempotencyKey")).toEqual(expect.any(String));
    expect(inOther?.get("idempotencyKey")).not.toBe(inSandbox?.get("idempotencyKey"));
  });

  it("points to adding a wallet when the provider was set up in the meantime", async () => {
    mocks.initialize.mockResolvedValueOnce({ status: "provider_already_set_up" } as never);
    renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
    fireEvent.change(screen.getByLabelText("Wallet label"), { target: { value: "Ops" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "This provider is already set up. Add a wallet instead."
    );
    expect(dashboardRouter.refresh).toHaveBeenCalled();
    expect(dashboardRouter.push).not.toHaveBeenCalled();
  });

  it("names the production environment on a production project", () => {
    renderFlow({
      connectedProviders: [],
      custodyAvailability: SANDBOX_AVAILABILITY,
      environment: "production",
      initialProvider: "turnkey",
    });
    expect(screen.getByText(/^Production/)).toBeTruthy();
  });
});

describe("custody modes", () => {
  it("asks how a provider offered both ways is set up, and shows nothing else until it is chosen", () => {
    renderFlow({ connectedProviders: [], initialProvider: "privy" });

    expect(screen.getByLabelText("Custody mode")).toBeTruthy();
    expect(document.getElementById("wallet-details-form")).toBeNull();
    expect(document.querySelector("[data-privy-byok-form]")).toBeNull();
  });

  it("sends a provider offered only as BYOK straight to its credential form", () => {
    renderFlow({
      connectedProviders: [],
      custodyAvailability: PRODUCTION_AVAILABILITY,
      environment: "production",
      initialProvider: "privy",
    });
    expect(screen.getByRole("heading", { name: "Provider details" })).toBeTruthy();
    expect(document.querySelector("[data-privy-byok-form]")).toBeTruthy();
    expect(screen.queryByLabelText("Custody mode")).toBeNull();
    // The credential form owns its submit; the footer offers no second one.
    expect(screen.queryByRole("button", { name: "Create wallet" })).toBeNull();
  });

  it("sets a Managed-only provider up with the wallet details", () => {
    renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
    expect(screen.getByRole("heading", { name: "Wallet details" })).toBeTruthy();
    expect(screen.queryByLabelText("Custody mode")).toBeNull();
  });
});

describe("connection picker", () => {
  function connection(overrides: Partial<ConnectionItem> = {}): ConnectionItem {
    return {
      id: "conn-active",
      provider: "privy",
      label: "Production signing",
      status: "active",
      isRuntimeExecutionAllowed: true,
      defaultCustodyWalletId: null,
      createdAt: "2026-08-10T09:00:00.000Z",
      activatedAt: "2026-08-10T09:05:00.000Z",
      lastCheck: null,
      pendingWalletLabel: null,
      ...overrides,
    } as ConnectionItem;
  }

  const pickerField = () => document.querySelector('input[name="walletTarget"]');

  it("offers the connection once the project has a usable one, with nothing preselected", () => {
    renderFlow({
      initialProvider: "privy",
      connectedProviders: ["privy"],
      connections: [connection()],
    });
    expect(screen.getByText("Account")).toBeTruthy();
    expect((pickerField() as HTMLInputElement | null)?.value ?? "").toBe("");
  });

  it("asks where the wallet lives instead of picking a default, and sends nothing until it does", async () => {
    renderFlow({
      initialProvider: "privy",
      connectedProviders: ["privy"],
      connections: [connection()],
    });
    fireEvent.change(screen.getByLabelText("Wallet label"), { target: { value: "Ops" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Choose the account the wallet is created in."
    );
    expect(mocks.createWallet).not.toHaveBeenCalled();
  });

  it("stays out of the way when nothing is selectable", () => {
    renderFlow({
      initialProvider: "privy",
      connectedProviders: ["privy"],
      connections: [connection({ status: "pending" })],
    });
    expect(pickerField()).toBeNull();
    expect(screen.getByRole("heading", { name: "Wallet details" })).toBeTruthy();
  });

  // A BYOK-only project has no Managed config, so nothing is connected; the active connection
  // alone must mark the provider installed.
  it("offers an active connection when the provider has no Managed config", () => {
    renderFlow({
      initialProvider: "privy",
      connectedProviders: [],
      custodyAvailability: PRODUCTION_AVAILABILITY,
      environment: "production",
      connections: [connection()],
    });
    expect(pickerField()).toBeTruthy();
    expect(document.querySelector("[data-privy-byok-form]")).toBeNull();
  });

  // Connections belong to one provider; switching on step 1 must not carry them over.
  it("ignores connections belonging to another provider", () => {
    renderFlow({
      connectedProviders: ["turnkey"],
      initialProvider: "turnkey",
      connections: [connection()],
    });
    expect(pickerField()).toBeNull();
  });
});
