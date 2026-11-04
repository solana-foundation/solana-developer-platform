// @vitest-environment jsdom

import { ThemeScopeProvider } from "@sdp/ui/theme-scope-provider";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InitializeCustodySetupActionResult,
  WalletSetupActionResult,
} from "@/app/(session)/dashboard/[projectId]/custody/actions";
import type { PrivyByokSubmitResult } from "@/app/(session)/dashboard/[projectId]/custody/byok-actions";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { availableCustodyProviders } from "@/lib/provider-availability";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";

const mocks = vi.hoisted(() => ({
  projectId: "prj_test_sandbox",
  createWallet: vi.fn(
    async (_formData: FormData): Promise<WalletSetupActionResult> => ({
      status: "success",
      walletId: "wallet_created",
    })
  ),
  initialize: vi.fn(
    async (_formData: FormData): Promise<InitializeCustodySetupActionResult> => ({
      status: "success",
      walletId: "wallet_initialized",
    })
  ),
  submitCredential: vi.fn(
    async (_formData: FormData): Promise<PrivyByokSubmitResult> => ({
      status: "success",
      connectionId: "conn_new",
    })
  ),
  refreshWalletInventory: vi.fn(),
}));

/** What a refusal settles about the browser's key: the API answered, nothing replayed. */
const REFUSED = { status: 422, replayed: false, code: null };

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
vi.mock("@/app/(session)/dashboard/[projectId]/custody/actions", () => ({
  createCustodySetupWalletAction: mocks.createWallet,
  initializeCustodySetupAction: mocks.initialize,
}));
vi.mock("@/app/(session)/dashboard/[projectId]/custody/byok-actions", () => ({
  submitPrivyCredentialAction: mocks.submitCredential,
  recheckPrivyCredentialAction: vi.fn(),
}));
vi.mock("@/app/(session)/dashboard/[projectId]/custody/use-wallet-inventory-refresh", () => ({
  useWalletInventoryRefresh: () => mocks.refreshWalletInventory,
}));

const { WalletSetupFlow } = await import("./wallet-setup-flow");
// A created wallet is confirmed with a toast; no Toaster is mounted to show it.
const toastSuccess = vi.spyOn(toast, "success").mockImplementation(() => "toast");

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

const PRODUCTION_BYOK_PAIR_AVAILABILITY = availableCustodyProviders(
  projectProviderAvailability({
    project: PRODUCTION_PROJECT,
    custody: [
      { provider: "privy", modes: ["byok"] },
      { provider: "fireblocks", modes: ["byok"] },
    ],
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

/** The element as `type`, or the test fails: a query finds an element, not its kind. */
function asElement<T extends Element>(element: Element | null, type: { new (): T }): T {
  if (!(element instanceof type)) {
    throw new Error(`Expected a ${type.name}`);
  }
  return element;
}

const createButton = () =>
  asElement(screen.getByRole("button", { name: /^Create wallet/ }), HTMLButtonElement);
const connectButton = () => screen.getByRole("button", { name: /^Connect and verify/ });
const footerHint = () => document.getElementById("wallet-setup-footer-hint")?.textContent;
const labelInput = () => asElement(screen.getByLabelText("Wallet label"), HTMLInputElement);
const typeLabel = (value: string) => fireEvent.change(labelInput(), { target: { value } });
const fillPrivyCredentials = () => {
  fireEvent.change(screen.getByLabelText("Privy app ID"), { target: { value: "app_1" } });
  fireEvent.change(screen.getByLabelText("Privy app secret"), { target: { value: "secret_1" } });
};

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
});

describe("one screen", () => {
  it("asks for the provider only when there is a choice, connected providers first", () => {
    renderFlow({ connectedProviders: ["dfns"] });

    expect(screen.getByRole("heading", { name: "Create wallet" })).toBeTruthy();
    expect(screen.queryByText(/Step \d of/)).toBeNull();
    const list = asElement(document.querySelector("[data-wallet-provider-list]"), HTMLElement);
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

    const formData = submitted(mocks.createWallet);
    expect(formData.get("provider")).toBe("turnkey");
    expect(formData.get("label")).toBe("Settlement wallet");
    expect(formData.get("purpose")).toBe("transfer");
    expect(toastSuccess).toHaveBeenCalledWith("Settlement wallet created");
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
    const formData = submitted(mocks.initialize);
    expect(formData.get("walletLabel")).toBe("Treasury");
    expect(formData.get("purpose")).toBeNull();
    expect(dashboardRouter.push).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/wallets/wallet_initialized"
    );
  });

  it("shows the API's refusal and stays on the page", async () => {
    mocks.createWallet.mockResolvedValueOnce({
      status: "error",
      message: "Provider rejected the request",
      answer: REFUSED,
    });
    renderFlow({ initialProvider: "turnkey" });
    typeLabel("Ops");
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(screen.getByRole("alert").textContent).toBe("Provider rejected the request");
    expect(dashboardRouter.push).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
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
      answer: REFUSED,
    });
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
    mocks.initialize.mockResolvedValueOnce({
      status: "provider_already_set_up",
      answer: { status: 409, replayed: false, code: null },
    });
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
  const managedAnswer = () =>
    asElement(screen.getByRole("radio", { name: /SDP's Privy account/ }), HTMLInputElement);
  const ownAnswer = () =>
    asElement(screen.getByRole("radio", { name: /Your own Privy account/ }), HTMLInputElement);

  it("asks whose account holds the keys, and creates nothing until it is answered", () => {
    renderFlow({ connectedProviders: [], custodyAvailability: PRIVY_ONLY_AVAILABILITY });

    expect(screen.getByRole("group", { name: "Whose Privy account holds the keys?" })).toBeTruthy();
    expect(managedAnswer().checked).toBe(false);
    expect(ownAnswer().checked).toBe(false);
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

    const credentialForm = asElement(
      document.querySelector("[data-privy-byok-form]"),
      HTMLFormElement
    );
    expect(credentialForm.id).toBe("wallet-details-form");
    // The flow's own label stands in for the form's, and submits with it.
    expect(screen.queryByLabelText("Initial wallet label")).toBeNull();
    expect(labelInput().value).toBe("Ops");
    expect(new FormData(credentialForm).get("walletLabel")).toBe("Ops");
    expect(screen.queryByRole("button", { name: /^Create wallet/ })).toBeNull();

    fillPrivyCredentials();
    await act(async () => {
      fireEvent.click(connectButton());
    });
    expect(submitted(mocks.submitCredential).get("walletLabel")).toBe("Ops");
    expect(toastSuccess).toHaveBeenCalledWith("Ops created");
    // The credential check settles without a wallet id, so the list is where it lands.
    expect(dashboardRouter.push).toHaveBeenCalledWith("/dashboard/prj_test_sandbox/wallets");
  });

  it("locks the answers while a credential check is in flight", async () => {
    let settle: (result: PrivyByokSubmitResult) => void = () => undefined;
    mocks.submitCredential.mockImplementationOnce(
      () =>
        new Promise<PrivyByokSubmitResult>((resolve) => {
          settle = resolve;
        })
    );
    renderFlow({ connectedProviders: [], custodyAvailability: SANDBOX_AVAILABILITY });
    fireEvent.click(screen.getByRole("radio", { name: /Privy/ }));
    typeLabel("Ops");
    fireEvent.click(ownAnswer());
    fillPrivyCredentials();

    await act(async () => {
      fireEvent.click(connectButton());
    });
    // Switching either answer would unmount the form that holds the request's recovery.
    expect(managedAnswer().disabled).toBe(true);
    expect(
      asElement(screen.getByRole("radio", { name: /Turnkey/ }), HTMLInputElement).disabled
    ).toBe(true);
    expect(labelInput().disabled).toBe(true);

    // Settled, so no transition stays pending for the tests after this one.
    await act(async () => {
      settle({ status: "failed", message: "Those credentials did not verify." });
    });
    expect(managedAnswer().disabled).toBe(false);
  });

  // Greptile (#2727): a refusal's panel hides the footer's primary, and the primary stayed
  // hidden after a changed answer mounted a fresh form.
  it("brings Connect and verify back when an answer changes after a refused check", async () => {
    mocks.submitCredential.mockResolvedValueOnce({
      status: "refused",
      message: "Privy refused these credentials.",
      connectionId: "conn_refused",
    });
    renderFlow({ connectedProviders: [], custodyAvailability: PRIVY_ONLY_AVAILABILITY });
    typeLabel("Ops");
    fireEvent.click(ownAnswer());
    fillPrivyCredentials();
    await act(async () => {
      fireEvent.click(connectButton());
    });
    // The refusal's panel carries its own way forward, so the footer's goes.
    expect(document.querySelector("[data-privy-byok-refused]")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Connect and verify/ })).toBeNull();

    fireEvent.click(managedAnswer());
    fireEvent.click(ownAnswer());
    expect(document.querySelector("[data-privy-byok-form]")).toBeTruthy();
    expect(connectButton()).toBeTruthy();
  });

  // Greptile (#2727): the credential form outlived a provider change, so a failed check's
  // connection went out with the next provider's credentials.
  it("starts a fresh credential check when the provider changes", async () => {
    mocks.submitCredential.mockResolvedValueOnce({
      status: "failed",
      message: "Those credentials did not verify.",
      connectionId: "conn_failed",
    });
    renderFlow({
      connectedProviders: [],
      custodyAvailability: PRODUCTION_BYOK_PAIR_AVAILABILITY,
      environment: "production",
    });
    fireEvent.click(screen.getByRole("radio", { name: /^Privy/ }));
    typeLabel("Ops");
    fillPrivyCredentials();
    await act(async () => {
      fireEvent.click(connectButton());
    });

    fireEvent.click(screen.getByRole("radio", { name: /^Fireblocks/ }));
    fireEvent.click(screen.getByRole("radio", { name: /^Privy/ }));
    fillPrivyCredentials();
    await act(async () => {
      fireEvent.click(connectButton());
    });
    expect(
      mocks.submitCredential.mock.calls.map(([formData]) => formData.get("connectionId"))
    ).toEqual([null, null]);
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
      createdAt: "2026-08-10T09:00:00.000Z",
      activatedAt: "2026-08-10T09:05:00.000Z",
      lastCheck: null,
      pendingWalletLabel: null,
      ...overrides,
    };
  }

  const pickerField = () => document.querySelector('input[name="walletTarget"]');

  it("offers the connection once the project has a usable one, with nothing preselected", () => {
    renderFlow({
      initialProvider: "privy",
      connectedProviders: ["privy"],
      connections: [connection()],
    });
    expect(screen.getByText("Account")).toBeTruthy();
    expect(asElement(pickerField(), HTMLInputElement).value).toBe("");
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

  // Greptile (#2727): the Account picker outlived a provider switch. An option both providers
  // offer ("Managed by SDP") stayed chosen, so the new provider's wallet skipped the question.
  it("asks for the account again when the provider changes", async () => {
    const user = userEvent.setup();
    renderFlow({
      connectedProviders: ["privy", "fireblocks"],
      custodyAvailability: availableCustodyProviders(
        projectProviderAvailability({
          project: SANDBOX_PROJECT,
          custody: [
            { provider: "privy", modes: ["managed", "byok"] },
            { provider: "fireblocks", modes: ["managed", "byok"] },
          ],
          compliance: [],
          ramps: [],
          earn: [],
        })
      ),
      connections: [
        connection({ id: "conn-privy", label: "Privy signing" }),
        connection({ id: "conn-fireblocks", provider: "fireblocks", label: "Fireblocks vaults" }),
      ],
    });
    fireEvent.click(screen.getByRole("radio", { name: /^Privy/ }));
    await user.click(screen.getByRole("combobox", { name: "Account" }));
    await user.click(await screen.findByRole("option", { name: "Managed by SDP" }));
    expect(asElement(pickerField(), HTMLInputElement).value).toBe("managed");

    fireEvent.click(screen.getByRole("radio", { name: /^Fireblocks/ }));
    expect(asElement(pickerField(), HTMLInputElement).value).toBe("");
    typeLabel("Ops");
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Choose the account the wallet is created in."
    );
    expect(mocks.createWallet).not.toHaveBeenCalled();
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
