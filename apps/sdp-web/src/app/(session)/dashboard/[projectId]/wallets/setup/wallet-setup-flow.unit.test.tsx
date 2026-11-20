// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import useSWR from "swr";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import * as custodyActions from "@/app/(session)/dashboard/[projectId]/wallets/actions";
import type { PrivyByokSubmitResult } from "@/app/(session)/dashboard/[projectId]/wallets/byok-actions";
import * as byokActions from "@/app/(session)/dashboard/[projectId]/wallets/byok-actions";
import { availableCustodyProviders } from "@/lib/provider-availability";
import { stubClerkSession } from "@/test/clerk";
import {
  dashboardDataResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import {
  dashboardRouter,
  resetDashboardNavigation,
  setDashboardUrl,
} from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { walletsWorkspace } from "@/test/wallets";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { WalletSetupFlow } = await import("./wallet-setup-flow");

/** What a refusal settles about the browser's key: the API answered, nothing replayed. */
const REFUSED = { status: 422, replayed: false, code: null };

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

/** A wallet inventory another feature reads; it counts how often it is read again. */
const inventoryRead = vi.fn(async () => "Wallets");
function InventoryReader() {
  useSWR(paymentsQueryKeys.actionWallets(), inventoryRead, {
    fallbackData: "Wallets",
    revalidateOnMount: false,
  });
  return null;
}

const SANDBOX_FLOW: FlowProps = {
  connectedProviders: ["turnkey"],
  custodyAvailability: SANDBOX_AVAILABILITY,
  environment: "sandbox",
  initialProvider: null,
  connections: [],
};

/** Renders the flow for the Sandbox Project, with `overrides` in place of its props. */
function renderFlow(overrides: Partial<FlowProps>) {
  return render(
    <>
      <WalletSetupFlow {...SANDBOX_FLOW} {...overrides} />
      <InventoryReader />
    </>,
    { wrapper: walletsWorkspace("admin") }
  );
}

/** The element as `type`, or the test fails: a query finds an element, not its kind. */
function asElement<T extends Element>(element: Element | null, type: { new (): T }): T {
  if (!(element instanceof type)) {
    throw new Error(`Expected a ${type.name}`);
  }
  return element;
}

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

const createButton = () =>
  asElement(screen.getByRole("button", { name: /^Create wallet/ }), HTMLButtonElement);
const connectButton = () => screen.getByRole("button", { name: /^Connect and create wallet/ });
const footerHint = () =>
  asElement(document.getElementById("wallet-setup-footer-hint"), HTMLElement).textContent;
const labelInput = () => asElement(screen.getByLabelText("Wallet label"), HTMLInputElement);
const typeLabel = (value: string) => fireEvent.change(labelInput(), { target: { value } });
const radio = (name: RegExp) => asElement(screen.getByRole("radio", { name }), HTMLInputElement);
const managedAnswer = () => radio(/^SDP's Privy account/);
const ownAnswer = () => radio(/^Your own Privy account/);
const accountList = () => document.querySelector("[data-wallet-account-list]");
const createdWith = () => screen.getByRole("region", { name: "Created with" });
const fillPrivyCredentials = () => {
  fireEvent.change(screen.getByLabelText("App ID"), { target: { value: "app_1" } });
  fireEvent.change(screen.getByLabelText("App secret"), { target: { value: "secret_1" } });
};

/** The form an action received on its `call`th call, or the test fails. */
function submitted(action: { mock: { calls: [FormData][] } }, call = 0): FormData {
  const sent = action.mock.calls[call];
  if (sent === undefined) {
    throw new Error(`The action has no call ${call}`);
  }
  return sent[0];
}

let createWallet: Mock<typeof custodyActions.createCustodySetupWalletAction>;
let initialize: Mock<typeof custodyActions.initializeCustodySetupAction>;
let submitCredential: Mock<typeof byokActions.submitPrivyCredentialAction>;
let toastSuccess: Mock<typeof toast.success>;
let dashboardFetch: Mock<typeof fetch>;

beforeEach(() => {
  resetDashboardNavigation();
  stubClerkSession();
  // Keys live in the tab's session storage; each test starts with none.
  window.sessionStorage.clear();
  createWallet = vi.fn<typeof custodyActions.createCustodySetupWalletAction>(async () => ({
    status: "success",
    walletId: "wallet_created",
  }));
  initialize = vi.fn<typeof custodyActions.initializeCustodySetupAction>(async () => ({
    status: "success",
    walletId: "wallet_initialized",
  }));
  submitCredential = vi.fn<typeof byokActions.submitPrivyCredentialAction>(async () => ({
    status: "success",
    connectionId: "conn_new",
  }));
  vi.spyOn(custodyActions, "createCustodySetupWalletAction").mockImplementation(createWallet);
  vi.spyOn(custodyActions, "initializeCustodySetupAction").mockImplementation(initialize);
  vi.spyOn(byokActions, "submitPrivyCredentialAction").mockImplementation(submitCredential);
  // A created wallet is confirmed with a toast; no Toaster is mounted to show it.
  toastSuccess = vi.fn<typeof toast.success>(() => "toast");
  vi.spyOn(toast, "success").mockImplementation(toastSuccess);
  inventoryRead.mockClear();
  // Fireblocks' fields read the project's registration CSR on mount; none is open yet.
  dashboardFetch = stubDashboardFetch((request) => {
    if (request.path === "/api/dashboard/fireblocks/csr") {
      return dashboardDataResponse(200, { csr: null });
    }
    throw new Error(`Unexpected dashboard request: ${request.path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("one screen", () => {
  it("asks for the provider only when there is a choice, by name, with its short summary", () => {
    renderFlow({ connectedProviders: ["dfns"] });

    expect(screen.queryByText(/Step \d of/)).toBeNull();
    const list = asElement(document.querySelector("[data-wallet-provider-list]"), HTMLElement);
    const names = [...list.querySelectorAll("[data-wallet-provider]")].map((row) =>
      row.getAttribute("data-wallet-provider")
    );
    expect(names).toEqual(["dfns", "privy", "turnkey"]);
    // A set-up provider is not marked: picking it shows what it offers.
    expect(within(list).queryByText("Active")).toBeNull();
    // The label is asked from the start, so choosing a provider never pops it in.
    expect(labelInput().value).toBe("");
  });

  it("opens on the only provider the project can use, with nothing to pick", () => {
    renderFlow({ custodyAvailability: PRODUCTION_AVAILABILITY, environment: "production" });

    expect(document.querySelector("[data-wallet-provider-list]")).toBeNull();
    expect(within(createdWith()).getByText("Privy")).toBeTruthy();
  });

  it("names what is still missing beside the disabled Create wallet", () => {
    renderFlow({});
    expect(createButton().disabled).toBe(true);
    expect(createButton().getAttribute("aria-describedby")).toBe("wallet-setup-footer-hint");
    expect(footerHint()).toBe("Pick a provider first.");

    fireEvent.click(radio(/Turnkey/));
    expect(footerHint()).toBe("Name the wallet first.");
    expect(createButton().disabled).toBe(true);

    typeLabel("Settlement wallet");
    expect(footerHint()).toBe("Turnkey makes the keys in under a minute.");
    expect(createButton().disabled).toBe(false);
  });

  it("keeps Enter on a choice from creating anything, and creates once from the label", async () => {
    renderFlow({});
    const turnkey = radio(/Turnkey/);
    fireEvent.click(turnkey);
    typeLabel("Ops");

    fireEvent.keyDown(turnkey, { key: "Enter" });
    expect(createWallet).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(labelInput(), { key: "Enter" });
    });
    expect(createWallet).toHaveBeenCalledTimes(1);
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

  it("leaves for the project's wallet list from Cancel when nothing was typed", () => {
    renderFlow({});
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dashboardRouter.push).toHaveBeenCalledWith("/dashboard/prj_test_sandbox/wallets");
  });

  it("asks before Cancel throws away what was typed", () => {
    renderFlow({ initialProvider: "turnkey" });
    typeLabel("Ops");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = screen.getByRole("dialog", { name: "Leave without creating the wallet?" });
    expect(dashboardRouter.push).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep going" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(labelInput().value).toBe("Ops");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(dashboardRouter.push).toHaveBeenCalledWith("/dashboard/prj_test_sandbox/wallets");
  });

  it("asks before Cancel when only credentials were typed", () => {
    renderFlow({
      connectedProviders: [],
      custodyAvailability: PRODUCTION_AVAILABILITY,
      environment: "production",
      initialProvider: "privy",
    });
    fireEvent.input(screen.getByLabelText("App ID"), { target: { value: "app_1" } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Leave without creating the wallet?" })).toBeTruthy();
    expect(dashboardRouter.push).not.toHaveBeenCalled();
  });

  // Greptile (#2741): after a lost answer the dialog said no wallet was made, though the
  // request may have created one.
  it("says the wallet may exist when Cancel follows a request that went out", async () => {
    initialize.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
    typeLabel("Unsure");
    await act(async () => {
      fireEvent.click(createButton());
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = screen.getByRole("dialog", { name: "Leave wallet setup?" });
    expect(within(dialog).getByText(/may have created the wallet/)).toBeTruthy();
    expect(within(dialog).queryByText(/No wallet has been made/)).toBeNull();
  });

  it("says the wallet may exist once a credential submission went out", async () => {
    submitCredential.mockResolvedValueOnce({
      status: "failed",
      message: "Those credentials did not verify.",
      connectionId: "conn_failed",
    });
    renderFlow({ connectedProviders: [], custodyAvailability: PRIVY_ONLY_AVAILABILITY });
    typeLabel("Ops");
    fireEvent.click(ownAnswer());
    fillPrivyCredentials();
    await act(async () => {
      fireEvent.click(connectButton());
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Leave wallet setup?" })).toBeTruthy();
  });
});

describe("details", () => {
  it("states what the wallet is created with, naming the provider once it is chosen", () => {
    renderFlow({});
    expect(within(createdWith()).queryByText("Provider")).toBeNull();

    fireEvent.click(radio(/Turnkey/));
    const summary = createdWith();
    expect(within(summary).getByText("Turnkey")).toBeTruthy();
    expect(within(summary).getByText(SANDBOX_PROJECT.name)).toBeTruthy();
    expect(within(summary).getByText("Sandbox · devnet")).toBeTruthy();
    // A Managed-only provider has no account to name.
    expect(within(summary).queryByText("Connection")).toBeNull();
    // The provider is chosen on this screen, so the summary has no way back to it.
    expect(within(summary).queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("creates another wallet with its label and purpose, then opens it with a toast", async () => {
    renderFlow({ initialProvider: "turnkey" });
    typeLabel("Settlement wallet");
    await act(async () => {
      fireEvent.click(createButton());
    });

    expect(Object.fromEntries(submitted(createWallet))).toEqual({
      provider: "turnkey",
      label: "Settlement wallet",
      purpose: "transfer",
      idempotencyKey: expect.any(String),
    });
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
    expect(within(createdWith()).getByText("Transfers")).toBeTruthy();

    typeLabel("Treasury");
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(Object.fromEntries(submitted(initialize))).toEqual({
      provider: "turnkey",
      walletLabel: "Treasury",
      idempotencyKey: expect.any(String),
    });
    expect(dashboardRouter.push).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/wallets/wallet_initialized"
    );
  });

  it("shows the API's refusal and stays on the page", async () => {
    createWallet.mockResolvedValueOnce({
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
    initialize.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
    typeLabel("Unsure");
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(inventoryRead).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toMatch(/Check your wallet list first/);

    initialize.mockResolvedValueOnce({
      status: "error",
      message: "Provider rejected the request",
      answer: REFUSED,
    });
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(inventoryRead).toHaveBeenCalledTimes(2);
    expect(dashboardRouter.push).not.toHaveBeenCalled();
  });

  it("keeps the form and the key when the answer is lost, so Create wallet again resends the same key", async () => {
    initialize.mockRejectedValueOnce(new TypeError("Failed to fetch"));
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
    const firstKey = submitted(initialize, 0).get("idempotencyKey");
    expect(firstKey).toEqual(expect.any(String));
    expect(submitted(initialize, 1).get("idempotencyKey")).toBe(firstKey);
    expect(createWallet).not.toHaveBeenCalled();
    expect(dashboardRouter.push).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/wallets/wallet_initialized"
    );
  });

  it("gives the same setup in another project its own key, so it never settles this one's", async () => {
    initialize.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const submit = async () => {
      renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
      typeLabel("Per-project treasury");
      await act(async () => {
        fireEvent.click(createButton());
      });
      cleanup();
    };

    await submit();
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/setup`, {});
    await submit();

    const inSandbox = submitted(initialize, 0).get("idempotencyKey");
    expect(inSandbox).toEqual(expect.any(String));
    expect(submitted(initialize, 1).get("idempotencyKey")).not.toBe(inSandbox);
  });

  it("sends the same details under a new key once the API refused them", async () => {
    createWallet.mockResolvedValueOnce({
      status: "error",
      message: "Provider rejected the request",
      answer: REFUSED,
    });
    renderFlow({ initialProvider: "turnkey" });
    typeLabel("Ops");
    await act(async () => {
      fireEvent.click(createButton());
    });
    await act(async () => {
      fireEvent.click(createButton());
    });

    const refusedKey = submitted(createWallet, 0).get("idempotencyKey");
    expect(refusedKey).toEqual(expect.any(String));
    expect(submitted(createWallet, 1).get("label")).toBe("Ops");
    expect(submitted(createWallet, 1).get("idempotencyKey")).not.toBe(refusedKey);
  });

  it("points to adding a wallet when the provider was set up in the meantime", async () => {
    initialize.mockResolvedValueOnce({
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
    expect(dashboardRouter.refresh).toHaveBeenCalledTimes(1);
    expect(dashboardRouter.push).not.toHaveBeenCalled();
  });

  it("names the production environment on a production project", () => {
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/setup`, {});
    renderFlow({
      connectedProviders: [],
      custodyAvailability: SANDBOX_AVAILABILITY,
      environment: "production",
      initialProvider: "turnkey",
    });
    expect(within(createdWith()).getByText("Production · mainnet")).toBeTruthy();
  });
});

describe("whose account", () => {
  it("asks whose account holds the keys, and creates nothing until it is answered", () => {
    renderFlow({ connectedProviders: [], custodyAvailability: PRIVY_ONLY_AVAILABILITY });

    expect(screen.getByRole("group", { name: "Whose Privy account holds the keys?" })).toBeTruthy();
    expect(managedAnswer().checked).toBe(false);
    expect(ownAnswer().checked).toBe(false);
    expect(document.getElementById("wallet-details-form")).toBeNull();
    expect(document.querySelector("[data-privy-byok-form]")).toBeNull();
    typeLabel("Treasury");
    expect(footerHint()).toBe("Pick whose Privy account holds the keys.");
    expect(createButton().disabled).toBe(true);
  });

  it("sets SDP's account up with the label typed before the answer, naming it in the summary", async () => {
    renderFlow({ connectedProviders: [], custodyAvailability: PRIVY_ONLY_AVAILABILITY });
    typeLabel("Treasury");
    fireEvent.click(managedAnswer());

    expect(within(createdWith()).getByText("SDP's Privy account")).toBeTruthy();
    expect(footerHint()).toBe("No wallet policy in SDP's Privy account.");
    expect(createButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(submitted(initialize).get("walletLabel")).toBe("Treasury");
  });

  it("puts the credential form under the question for the project's own account, keeping the label", async () => {
    renderFlow({ connectedProviders: [], custodyAvailability: PRIVY_ONLY_AVAILABILITY });
    typeLabel("Ops");
    fireEvent.click(ownAnswer());

    const credentialForm = asElement(
      document.querySelector("[data-privy-byok-form]"),
      HTMLFormElement
    );
    expect(credentialForm.id).toBe("wallet-details-form");
    // The credentials come first, then the wallet's details.
    const detailsTitle = screen.getByRole("heading", { name: "Wallet details" });
    expect(
      credentialForm.compareDocumentPosition(detailsTitle) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // The flow's own label stands in for the form's, and submits with it.
    expect(screen.queryByLabelText("First wallet name")).toBeNull();
    expect(labelInput().value).toBe("Ops");
    expect(new FormData(credentialForm).get("walletLabel")).toBe("Ops");
    expect(screen.queryByRole("button", { name: /^Create wallet/ })).toBeNull();
    expect(within(createdWith()).getByText("The Privy account you connect")).toBeTruthy();
    expect(footerHint()).toBe("SDP checks the credentials with Privy, then creates the wallet.");

    fillPrivyCredentials();
    await act(async () => {
      fireEvent.click(connectButton());
    });
    expect(submitted(submitCredential).get("walletLabel")).toBe("Ops");
    expect(toastSuccess).toHaveBeenCalledWith("Ops created");
    // The credential check settles without a wallet id, so the list is where it lands.
    expect(dashboardRouter.push).toHaveBeenCalledWith("/dashboard/prj_test_sandbox/wallets");
  });

  it("locks the answers while a credential check is in flight", async () => {
    let settle: (result: PrivyByokSubmitResult) => void = () => undefined;
    submitCredential.mockImplementationOnce(
      () =>
        new Promise<PrivyByokSubmitResult>((resolve) => {
          settle = resolve;
        })
    );
    renderFlow({ connectedProviders: [], custodyAvailability: SANDBOX_AVAILABILITY });
    fireEvent.click(radio(/Privy/));
    typeLabel("Ops");
    fireEvent.click(ownAnswer());
    fillPrivyCredentials();

    await act(async () => {
      fireEvent.click(connectButton());
    });
    // Switching either answer would unmount the form that holds the request's recovery.
    expect(managedAnswer().disabled).toBe(true);
    expect(radio(/Turnkey/).disabled).toBe(true);
    expect(labelInput().disabled).toBe(true);

    // Settled, so no transition stays pending for the tests after this one.
    await act(async () => {
      settle({ status: "failed", message: "Those credentials did not verify." });
    });
    expect(managedAnswer().disabled).toBe(false);
  });

  // Greptile (#2727): a refusal's panel hides the footer's primary, and the primary stayed
  // hidden after a changed answer mounted a fresh form.
  it("brings Connect and create wallet back when an answer changes after a refused check", async () => {
    submitCredential.mockResolvedValueOnce({
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
    expect(document.querySelector("[data-privy-byok-refused]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Connect and create wallet/ })).toBeNull();

    fireEvent.click(managedAnswer());
    fireEvent.click(ownAnswer());
    expect(document.querySelector("[data-privy-byok-form]")).not.toBeNull();
    expect(connectButton()).toBeTruthy();
  });

  // Greptile (#2727): the credential form outlived a provider change, so a failed check's
  // connection went out with the next provider's credentials.
  it("starts a fresh credential check when the provider changes", async () => {
    submitCredential.mockResolvedValueOnce({
      status: "failed",
      message: "Those credentials did not verify.",
      connectionId: "conn_failed",
    });
    renderFlow({
      connectedProviders: [],
      custodyAvailability: PRODUCTION_BYOK_PAIR_AVAILABILITY,
      environment: "production",
    });
    fireEvent.click(radio(/^Privy/));
    typeLabel("Ops");
    fillPrivyCredentials();
    await act(async () => {
      fireEvent.click(connectButton());
    });

    fireEvent.click(radio(/^Fireblocks/));
    fireEvent.click(radio(/^Privy/));
    fillPrivyCredentials();
    await act(async () => {
      fireEvent.click(connectButton());
    });
    expect(submitted(submitCredential, 0).get("connectionId")).toBeNull();
    expect(submitted(submitCredential, 1).get("connectionId")).toBeNull();
  });

  it("asks nothing to pick when the project's own account is the only answer", () => {
    renderFlow({
      connectedProviders: [],
      custodyAvailability: PRODUCTION_AVAILABILITY,
      environment: "production",
      initialProvider: "privy",
    });
    expect(
      screen.getByRole("heading", { name: "Whose Privy account holds the keys?" })
    ).toBeTruthy();
    expect(screen.getByText("Production uses your own. Connect it below.")).toBeTruthy();
    expect(accountList()).toBeNull();
    expect(document.querySelector("[data-privy-byok-form]")).not.toBeNull();
    expect(connectButton()).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Create wallet/ })).toBeNull();
  });

  // Windscar (#2741): an inline pending handler changed identity every render, so Fireblocks'
  // CSR read restarted each time it reported, and its pending edge counted as a sent request.
  it("reads the Fireblocks CSR once, and the read sends no wallet request", async () => {
    renderFlow({
      connectedProviders: [],
      custodyAvailability: availableCustodyProviders(
        projectProviderAvailability({
          project: PRODUCTION_PROJECT,
          custody: [{ provider: "fireblocks", modes: ["byok"] }],
          compliance: [],
          ramps: [],
          earn: [],
        })
      ),
      environment: "production",
      initialProvider: "fireblocks",
    });
    for (let settle = 0; settle < 5; settle += 1) {
      await act(async () => {});
    }
    expect(sentDashboardRequests(dashboardFetch)).toEqual([
      {
        path: "/api/dashboard/fireblocks/csr",
        method: "GET",
        idempotencyKey: null,
        body: undefined,
      },
    ]);

    // Nothing was typed and nothing was sent, so Cancel leaves at once.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dashboardRouter.push).toHaveBeenCalledWith("/dashboard/prj_test_sandbox/wallets");
  });

  it("sets a Managed-only provider up with the wallet details and no account question", () => {
    renderFlow({ connectedProviders: [], initialProvider: "turnkey" });
    expect(screen.queryByText("Whose Turnkey account holds the keys?")).toBeNull();
    expect(accountList()).toBeNull();
    expect(document.getElementById("wallet-details-form")).not.toBeNull();
  });

  it("lists the provider's connections beside SDP's account, with nothing preselected", () => {
    renderFlow({
      initialProvider: "privy",
      connectedProviders: ["privy"],
      connections: [connection()],
    });
    const list = asElement(accountList(), HTMLElement);
    expect(
      [...list.querySelectorAll("[data-wallet-account]")].map((row) =>
        row.getAttribute("data-wallet-account")
      )
    ).toEqual(["managed", "conn-active", "own"]);
    expect(radio(/^Connect another Privy account/)).toBeTruthy();
    for (const answer of within(list).getAllByRole("radio")) {
      expect(asElement(answer, HTMLInputElement).checked).toBe(false);
    }
    expect(footerHint()).toBe("Pick whose Privy account holds the keys.");
    expect(document.getElementById("wallet-details-form")).toBeNull();
  });

  it("creates the wallet in the connection picked, with its purpose", async () => {
    renderFlow({
      initialProvider: "privy",
      connectedProviders: ["privy"],
      connections: [connection()],
    });
    fireEvent.click(radio(/^Production signing/));
    typeLabel("Ops");
    expect(within(createdWith()).getByText("Production signing")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Purpose" })).toBeTruthy();
    expect(footerHint()).toBe("Privy makes the keys in under a minute.");

    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(Object.fromEntries(submitted(createWallet))).toEqual({
      provider: "privy",
      connectionId: "conn-active",
      label: "Ops",
      purpose: "transfer",
      idempotencyKey: expect.any(String),
    });
  });

  it("creates the wallet in SDP's set-up account when that is picked", async () => {
    renderFlow({
      initialProvider: "privy",
      connectedProviders: ["privy"],
      connections: [connection()],
    });
    fireEvent.click(managedAnswer());
    typeLabel("Ops");
    await act(async () => {
      fireEvent.click(createButton());
    });
    const formData = submitted(createWallet);
    expect(formData.get("provider")).toBe("privy");
    expect(formData.get("connectionId")).toBeNull();
    expect(initialize).not.toHaveBeenCalled();
  });

  it("connects another account of the project's own from the list", () => {
    renderFlow({
      initialProvider: "privy",
      connectedProviders: ["privy"],
      connections: [connection()],
    });
    fireEvent.click(radio(/^Connect another Privy account/));
    expect(document.querySelector("[data-privy-byok-form]")).not.toBeNull();
    expect(connectButton()).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Purpose" })).toBeNull();
  });

  it("keeps a connection that cannot take a wallet on the list, with a link to fix it", () => {
    renderFlow({
      initialProvider: "privy",
      connectedProviders: ["privy"],
      connections: [
        connection({ id: "conn-pending", label: "Ops app", status: "pending" }),
        connection({
          id: "conn-failed",
          label: "Staging app",
          status: "failed",
          lastCheck: { status: "failed", at: null, failureCode: "invalid_credentials" },
        }),
        connection({ id: "conn-gone", label: "Old app", status: "deactivated" }),
      ],
    });
    const list = asElement(accountList(), HTMLElement);
    expect(within(list).queryByText("Old app")).toBeNull();
    // Only SDP's account and a new one can take the wallet.
    expect(within(list).getAllByRole("radio")).toHaveLength(2);

    const pending = asElement(
      list.querySelector('[data-wallet-account="conn-pending"]'),
      HTMLElement
    );
    expect(within(pending).getByText("Setup not finished")).toBeTruthy();
    expect(within(pending).getByRole("link", { name: "Check again" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/integrations/privy/connections/conn-pending"
    );
    const failed = asElement(
      list.querySelector('[data-wallet-account="conn-failed"]'),
      HTMLElement
    );
    expect(within(failed).getByText("Privy rejected its keys")).toBeTruthy();
    expect(
      within(failed).getByRole("link", { name: "Replace credentials" }).getAttribute("href")
    ).toBe("/dashboard/prj_test_sandbox/integrations/privy/connections/conn-failed");
  });

  // Greptile (#2741): the repair link stayed live during a credential check, so leaving through
  // it dropped the request's saved retry.
  it("locks a connection's repair link while a credential check is in flight", async () => {
    let settle: (result: PrivyByokSubmitResult) => void = () => undefined;
    submitCredential.mockImplementationOnce(
      () =>
        new Promise<PrivyByokSubmitResult>((resolve) => {
          settle = resolve;
        })
    );
    renderFlow({
      initialProvider: "privy",
      connectedProviders: ["privy"],
      connections: [connection({ id: "conn-pending", label: "Ops app", status: "pending" })],
    });
    typeLabel("Ops");
    fireEvent.click(radio(/^Connect another Privy account/));
    fillPrivyCredentials();
    const row = asElement(
      document.querySelector('[data-wallet-account="conn-pending"]'),
      HTMLElement
    );
    expect(within(row).getByRole("link", { name: "Check again" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/integrations/privy/connections/conn-pending"
    );

    await act(async () => {
      fireEvent.click(connectButton());
    });
    expect(within(row).queryByRole("link", { name: "Check again" })).toBeNull();
    expect(within(row).getByText("Check again")).toBeTruthy();

    // Settled, so no transition stays pending for the tests after this one.
    await act(async () => {
      settle({ status: "failed", message: "Those credentials did not verify." });
    });
    expect(within(row).getByRole("link", { name: "Check again" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/integrations/privy/connections/conn-pending"
    );
  });

  // A BYOK-only project has no Managed config, so nothing is connected; the active connection
  // alone must offer the wallet a place to go.
  it("offers an active connection when the provider has no Managed config", () => {
    renderFlow({
      initialProvider: "privy",
      connectedProviders: [],
      custodyAvailability: PRODUCTION_AVAILABILITY,
      environment: "production",
      connections: [connection()],
    });
    expect(
      screen.getByText("Production uses your own, fixed once the wallet exists.")
    ).toBeTruthy();
    expect(radio(/^Production signing/)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /^SDP's Privy account/ })).toBeNull();
    expect(document.querySelector("[data-privy-byok-form]")).toBeNull();
  });

  // Greptile (#2727): the account outlived a provider switch. An answer both providers offer
  // (SDP's account) stayed chosen, so the new provider's wallet skipped the question.
  it("asks for the account again when the provider changes", () => {
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
    fireEvent.click(radio(/^Privy/));
    fireEvent.click(managedAnswer());
    expect(managedAnswer().checked).toBe(true);

    fireEvent.click(radio(/^Fireblocks/));
    expect(radio(/^SDP's Fireblocks account/).checked).toBe(false);
    expect(screen.queryByText("Privy signing")).toBeNull();
    typeLabel("Ops");
    expect(footerHint()).toBe("Pick whose Fireblocks account holds the keys.");
    expect(createButton().disabled).toBe(true);

    fireEvent.click(radio(/^SDP's Fireblocks account/));
    expect(footerHint()).toBe("Fireblocks makes the keys in under a minute.");
  });

  // Connections belong to one provider; switching provider must not carry them over.
  it("ignores connections belonging to another provider", () => {
    renderFlow({
      connectedProviders: ["turnkey"],
      initialProvider: "turnkey",
      connections: [connection()],
    });
    expect(accountList()).toBeNull();
    expect(screen.queryByText("Production signing")).toBeNull();
  });
});
