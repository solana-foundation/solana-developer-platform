// @vitest-environment jsdom

import { ThemeScopeProvider } from "@sdp/ui/theme-scope-provider";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { availableCustodyProviders } from "@/lib/provider-availability";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";

type SubmitResult =
  | { status: "success"; connectionId: string }
  | { status: "failed"; message: string };

const mocks = vi.hoisted(() => ({
  projectId: "prj_test_sandbox",
  createWallet: vi.fn(async (_formData: FormData) => ({
    status: "success" as const,
    walletId: "wallet_created",
  })),
  initialize: vi.fn(async (_formData: FormData) => ({
    status: "success" as const,
    walletId: "wallet_initialized",
  })),
  submitCredential: vi.fn(
    async (_formData: FormData): Promise<SubmitResult> => ({
      status: "success",
      connectionId: "conn_new",
    })
  ),
  refreshWalletInventory: vi.fn(),
  toastSuccess: vi.fn(),
  purposeOffered: vi.fn((_purpose: string) => true),
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { userId: "user_test", orgId: "org_test" },
    flags: { dvp: false, issuance: true, markets: false },
    selectedProjectId: mocks.projectId,
    projects: [{ id: "prj_test_sandbox", name: "Default Sandbox Project" }],
    sdpEnvironment: "sandbox",
  }),
}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn(), loading: vi.fn() },
}));
vi.mock("@/app/dashboard/[projectId]/custody/actions", () => ({
  createCustodySetupWalletAction: mocks.createWallet,
  initializeCustodySetupAction: mocks.initialize,
}));
vi.mock("@/app/dashboard/[projectId]/custody/byok-actions", () => ({
  submitPrivyCredentialAction: mocks.submitCredential,
  recheckPrivyCredentialAction: vi.fn(),
}));
vi.mock("@/app/dashboard/[projectId]/custody/use-wallet-inventory-refresh", () => ({
  useWalletInventoryRefresh: () => mocks.refreshWalletInventory,
}));
// Every purpose is on offer unless a test narrows it; `wallet-purposes` pins the stable list.
vi.mock("@/app/dashboard/[projectId]/custody/wallet-purposes", () => ({
  isWalletPurposeOffered: (purpose: string) => mocks.purposeOffered(purpose),
}));

const { WalletSetupFlow } = await import("./wallet-setup-flow");

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

const PRIVY_ONLY_AVAILABILITY = availableCustodyProviders(
  projectProviderAvailability({
    project: SANDBOX_PROJECT,
    custody: [{ provider: "privy", modes: ["managed", "byok"] }],
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

const createButton = () =>
  screen.getByRole("button", { name: /^Create wallet/ }) as HTMLButtonElement;
const footerHint = () => document.getElementById("wallet-setup-footer-hint")?.textContent;
const labelInput = () => screen.getByLabelText("Wallet label") as HTMLInputElement;
const typeLabel = (value: string) => fireEvent.change(labelInput(), { target: { value } });

/** The form an action received on its first call. */
function submitted(action: { mock: { calls: [FormData][] } }): FormData {
  const [call] = action.mock.calls;
  if (call === undefined) {
    throw new Error("The action was not called");
  }
  return call[0];
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.projectId = "prj_test_sandbox";
  mocks.purposeOffered.mockImplementation(() => true);
});

describe("one screen", () => {
  it("asks for the provider only when there is a choice, connected providers first", () => {
    renderFlow({ connectedProviders: ["dfns"] });

    expect(screen.getByRole("heading", { name: "Create wallet" })).toBeTruthy();
    expect(screen.queryByText(/Step \d of/)).toBeNull();
    const list = document.querySelector("[data-wallet-provider-list]") as HTMLElement;
    const names = [...list.querySelectorAll("[data-wallet-provider]")].map((row) =>
      row.getAttribute("data-wallet-provider")
    );
    expect(names[0]).toBe("dfns");
    expect(new Set(names)).toEqual(new Set(["turnkey", "dfns", "privy"]));
    expect(within(list).getAllByText("Active")).toHaveLength(1);
    // The label is asked from the start, so choosing a provider never pops it in.
    expect(labelInput()).toBeTruthy();
  });

  it("opens on the only provider the project can use, with nothing to pick", () => {
    renderFlow({ custodyAvailability: PRODUCTION_AVAILABILITY, environment: "production" });

    expect(document.querySelector("[data-wallet-provider-list]")).toBeNull();
    const createdWith = screen.getByRole("region", { name: "Created with" });
    expect(within(createdWith).getByText("Privy")).toBeTruthy();
  });

  it("names what is still missing beside the disabled Create wallet", () => {
    renderFlow();
    expect(createButton().disabled).toBe(true);
    expect(createButton().getAttribute("aria-describedby")).toBe("wallet-setup-footer-hint");
    expect(footerHint()).toBe("Choose an enabled provider to continue.");

    fireEvent.click(screen.getByRole("radio", { name: /Turnkey/ }));
    expect(footerHint()).toBe("Name the wallet to continue.");
    expect(createButton().disabled).toBe(true);

    typeLabel("Settlement wallet");
    expect(footerHint()).toBe("Turnkey creates the keys when you confirm.");
    expect(createButton().disabled).toBe(false);
  });

  it("keeps Enter on a choice from creating anything, and creates once from the label", async () => {
    renderFlow();
    const turnkey = screen.getByRole("radio", { name: /Turnkey/ });
    fireEvent.click(turnkey);
    typeLabel("Ops");

    fireEvent.keyDown(turnkey, { key: "Enter" });
    expect(mocks.createWallet).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(labelInput(), { key: "Enter" });
    });
    expect(mocks.createWallet).toHaveBeenCalledTimes(1);
  });

  it("says so when the project can use no provider, instead of emptying the page", () => {
    renderFlow({ connectedProviders: [], custodyAvailability: [] });
    expect(
      screen.getByText(
        "Wallet creation is available after a custody provider is enabled for this organization."
      )
    ).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Create wallet/ })).toBeNull();
  });

  it("leaves for the project's wallet list from Cancel", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dashboardRouter.push).toHaveBeenCalledWith("/dashboard/prj_test_sandbox/wallets");
  });
});

describe("details", () => {
  it("states what the wallet is created with", () => {
    renderFlow({ initialProvider: "turnkey" });

    const createdWith = screen.getByRole("region", { name: "Created with" });
    expect(within(createdWith).getByText("Turnkey")).toBeTruthy();
    expect(within(createdWith).getByText("Default Sandbox Project")).toBeTruthy();
    expect(within(createdWith).getByText("Sandbox · devnet")).toBeTruthy();
    // The provider is chosen on this screen, so the summary has no way back to it.
    expect(within(createdWith).queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("creates another wallet with its label and purpose, then opens it with a toast", async () => {
    renderFlow({ initialProvider: "turnkey" });
    typeLabel("Settlement wallet");
    await act(async () => {
      fireEvent.click(createButton());
    });

    const formData = mocks.createWallet.mock.calls[0]?.[0] as FormData;
    expect(formData.get("provider")).toBe("turnkey");
    expect(formData.get("label")).toBe("Settlement wallet");
    expect(formData.get("purpose")).toBe("transfer");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Settlement wallet created");
    expect(dashboardRouter.push).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/wallets/wallet_created"
    );
    // The action revalidated the wallet pages; refreshing this one would only re-run its reads.
    expect(dashboardRouter.refresh).not.toHaveBeenCalled();
  });

  it("fixes a first wallet as a transfer wallet in the summary, with no picker", async () => {
    renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
    expect(screen.queryByRole("combobox", { name: "Purpose" })).toBeNull();
    const createdWith = screen.getByRole("region", { name: "Created with" });
    expect(within(createdWith).getByText("Transfers")).toBeTruthy();

    typeLabel("Treasury");
    await act(async () => {
      fireEvent.click(createButton());
    });
    const formData = mocks.initialize.mock.calls[0]?.[0] as FormData;
    expect(formData.get("walletLabel")).toBe("Treasury");
    expect(formData.get("purpose")).toBeNull();
    expect(dashboardRouter.push).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/wallets/wallet_initialized"
    );
  });

  it("sends the only purpose offered without asking for it", async () => {
    mocks.purposeOffered.mockImplementation((purpose) => purpose === "transfer");
    renderFlow({ initialProvider: "turnkey" });
    expect(screen.queryByRole("combobox", { name: "Purpose" })).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Created with" })).getByText("Transfers")
    ).toBeTruthy();

    typeLabel("Ops");
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(submitted(mocks.createWallet).get("purpose")).toBe("transfer");
  });

  it("shows the API's refusal and stays on the page", async () => {
    mocks.createWallet.mockResolvedValueOnce({
      status: "error",
      message: "Provider rejected the request",
    } as never);
    renderFlow({ initialProvider: "turnkey" });
    typeLabel("Ops");
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(screen.getByRole("alert").textContent).toBe("Provider rejected the request");
    expect(dashboardRouter.push).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  // Jina (#2333): an uncertain or refused setup left the wallet inventory as it
  // was, so a wallet an earlier attempt created did not show up before a retry.
  it("refreshes the wallet inventory after an uncertain or refused setup and points to the list", async () => {
    mocks.initialize.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
    typeLabel("Unsure");
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(mocks.refreshWalletInventory).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toMatch(/Check your wallet list first/);

    mocks.initialize.mockResolvedValueOnce({
      status: "error",
      message: "Provider rejected the request",
    } as never);
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(mocks.refreshWalletInventory).toHaveBeenCalledTimes(2);
    expect(dashboardRouter.push).not.toHaveBeenCalled();
  });

  it("keeps the form and the key when the answer is lost, so Create wallet again resends the same key", async () => {
    mocks.initialize.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
    typeLabel("Lost answer treasury");
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(screen.getByRole("alert").textContent).toMatch(
      /couldn't confirm whether the wallet was created/
    );
    expect(dashboardRouter.push).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(createButton());
    });
    const [first, retry] = mocks.initialize.mock.calls.map(([form]) => form);
    expect(first?.get("idempotencyKey")).toEqual(expect.any(String));
    expect(retry?.get("idempotencyKey")).toBe(first?.get("idempotencyKey"));
    expect(mocks.createWallet).not.toHaveBeenCalled();
    expect(dashboardRouter.push).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/wallets/wallet_initialized"
    );
  });

  it("gives the same setup in another project its own key, so it never settles this one's", async () => {
    mocks.initialize.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const submit = async () => {
      renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
      typeLabel("Per-project treasury");
      await act(async () => {
        fireEvent.click(createButton());
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
    typeLabel("Ops");
    await act(async () => {
      fireEvent.click(createButton());
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
  const managedAnswer = () => screen.getByRole("radio", { name: /SDP's Privy account/ });
  const ownAnswer = () => screen.getByRole("radio", { name: /Your own Privy account/ });

  it("asks whose account holds the keys, and creates nothing until it is answered", () => {
    renderFlow({ connectedProviders: [], custodyAvailability: PRIVY_ONLY_AVAILABILITY });

    expect(screen.getByRole("group", { name: "Whose Privy account holds the keys?" })).toBeTruthy();
    expect((managedAnswer() as HTMLInputElement).checked).toBe(false);
    expect((ownAnswer() as HTMLInputElement).checked).toBe(false);
    expect(document.getElementById("wallet-details-form")).toBeNull();
    expect(document.querySelector("[data-privy-byok-form]")).toBeNull();
    typeLabel("Treasury");
    expect(footerHint()).toBe("Choose whose Privy account holds the keys.");
    expect(createButton().disabled).toBe(true);
  });

  it("sets SDP's account up with the label typed before the answer", async () => {
    renderFlow({ connectedProviders: [], custodyAvailability: PRIVY_ONLY_AVAILABILITY });
    typeLabel("Treasury");
    fireEvent.click(managedAnswer());

    expect(createButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(submitted(mocks.initialize).get("walletLabel")).toBe("Treasury");
  });

  it("swaps in the credential form for the project's own account, keeping the label", async () => {
    renderFlow({ connectedProviders: [], custodyAvailability: PRIVY_ONLY_AVAILABILITY });
    typeLabel("Ops");
    fireEvent.click(ownAnswer());

    const credentialForm = document.querySelector("[data-privy-byok-form]") as HTMLFormElement;
    expect(credentialForm.id).toBe("wallet-details-form");
    // The flow's own label stands in for the form's, and submits with it.
    expect(screen.queryByLabelText("Initial wallet label")).toBeNull();
    expect(labelInput().value).toBe("Ops");
    expect(new FormData(credentialForm).get("walletLabel")).toBe("Ops");
    expect(screen.queryByRole("button", { name: /^Create wallet/ })).toBeNull();

    fireEvent.change(screen.getByLabelText("Privy app ID"), { target: { value: "app_1" } });
    fireEvent.change(screen.getByLabelText("Privy app secret"), { target: { value: "secret_1" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Connect and verify/ }));
    });
    expect(submitted(mocks.submitCredential).get("walletLabel")).toBe("Ops");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Ops created");
    // The credential check settles without a wallet id, so the list is where it lands.
    expect(dashboardRouter.push).toHaveBeenCalledWith("/dashboard/prj_test_sandbox/wallets");
  });

  it("locks the answers while a credential check is in flight", async () => {
    let settle: (result: SubmitResult) => void = () => undefined;
    mocks.submitCredential.mockImplementationOnce(
      () =>
        new Promise<SubmitResult>((resolve) => {
          settle = resolve;
        })
    );
    renderFlow({ connectedProviders: [], custodyAvailability: SANDBOX_AVAILABILITY });
    fireEvent.click(screen.getByRole("radio", { name: /Privy/ }));
    typeLabel("Ops");
    fireEvent.click(ownAnswer());
    fireEvent.change(screen.getByLabelText("Privy app ID"), { target: { value: "app_1" } });
    fireEvent.change(screen.getByLabelText("Privy app secret"), { target: { value: "secret_1" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Connect and verify/ }));
    });
    // Switching either answer would unmount the form that holds the request's recovery.
    expect((managedAnswer() as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: /Turnkey/ }) as HTMLInputElement).disabled).toBe(
      true
    );
    expect(labelInput().disabled).toBe(true);

    // Settled, so no transition stays pending for the tests after this one.
    await act(async () => {
      settle({ status: "failed", message: "Those credentials did not verify." });
    });
    expect((managedAnswer() as HTMLInputElement).disabled).toBe(false);
  });

  it("sends a provider offered only as BYOK straight to its credential form", () => {
    renderFlow({
      connectedProviders: [],
      custodyAvailability: PRODUCTION_AVAILABILITY,
      environment: "production",
      initialProvider: "privy",
    });
    expect(document.querySelector("[data-privy-byok-form]")).toBeTruthy();
    expect(document.querySelector("[data-wallet-mode-list]")).toBeNull();
    expect(screen.getByRole("button", { name: /^Connect and verify/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Create wallet/ })).toBeNull();
  });

  it("sets a Managed-only provider up with the wallet details", () => {
    renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
    expect(document.querySelector("[data-wallet-mode-list]")).toBeNull();
    expect(document.getElementById("wallet-details-form")).toBeTruthy();
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
    typeLabel("Ops");
    await act(async () => {
      fireEvent.click(createButton());
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
    expect(document.getElementById("wallet-details-form")).toBeTruthy();
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

  // Connections belong to one provider; switching provider must not carry them over.
  it("ignores connections belonging to another provider", () => {
    renderFlow({
      connectedProviders: ["turnkey"],
      initialProvider: "turnkey",
      connections: [connection()],
    });
    expect(pickerField()).toBeNull();
  });
});
