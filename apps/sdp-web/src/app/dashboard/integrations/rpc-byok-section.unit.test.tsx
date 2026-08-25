// @vitest-environment jsdom

import type { SafeRpcConnection } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const submitRpcConnectionAction = vi.fn();
const activateRpcConnectionAction = vi.fn();
const deactivateRpcConnectionAction = vi.fn();
const deleteRpcConnectionAction = vi.fn();
const testRpcConnectionAction = vi.fn();
const rotateRpcConnectionAction = vi.fn();
const setRpcCredentialModeAction = vi.fn();

vi.mock("./rpc-connection-actions", () => ({
  submitRpcConnectionAction: (fd: FormData) => submitRpcConnectionAction(fd),
  activateRpcConnectionAction: (fd: FormData) => activateRpcConnectionAction(fd),
  deactivateRpcConnectionAction: (fd: FormData) => deactivateRpcConnectionAction(fd),
  deleteRpcConnectionAction: (fd: FormData) => deleteRpcConnectionAction(fd),
  testRpcConnectionAction: (fd: FormData) => testRpcConnectionAction(fd),
  rotateRpcConnectionAction: (fd: FormData) => rotateRpcConnectionAction(fd),
  setRpcCredentialModeAction: (fd: FormData) => setRpcCredentialModeAction(fd),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), loading: vi.fn(), success: vi.fn() }),
}));

// jsdom ships no matchMedia, and the deactivate control is a hold-to-confirm
// button that asks about reduced motion on mount.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { RpcByokSection } from "./rpc-byok-section";

function connection(overrides: Partial<SafeRpcConnection> = {}): SafeRpcConnection {
  return {
    id: "rconn_1",
    provider: "helius",
    scope: "project",
    projectId: "prj_1",
    network: "devnet",
    status: "active",
    isDefault: true,
    displayMetadata: { endpointHost: "tenant.example", apiKeySuffix: "1234" },
    createdAt: "2026-08-16T00:00:00.000Z",
    activatedAt: "2026-08-16T00:00:00.000Z",
    deactivatedAt: null,
    providerCredential: { id: "pcred_1", label: "Production key", status: "active" },
    ...overrides,
  };
}

function renderSection(props: Partial<ComponentProps<typeof RpcByokSection>> = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
  return render(<RpcByokSection canManage connections={[]} provider="helius" {...props} />, {
    wrapper,
  });
}

beforeEach(() => {
  submitRpcConnectionAction.mockReset();
  activateRpcConnectionAction.mockReset();
  deactivateRpcConnectionAction.mockReset();
  deleteRpcConnectionAction.mockReset();
  testRpcConnectionAction.mockReset();
  rotateRpcConnectionAction.mockReset();
  setRpcCredentialModeAction.mockReset();
  setRpcCredentialModeAction.mockResolvedValue({ status: "saved", mode: "byok" });
  rotateRpcConnectionAction.mockResolvedValue({ status: "success", connection: connection() });
  submitRpcConnectionAction.mockResolvedValue({ status: "success", connection: connection() });
  activateRpcConnectionAction.mockResolvedValue({ status: "success", connection: connection() });
  deactivateRpcConnectionAction.mockResolvedValue({ status: "success", connection: connection() });
  deleteRpcConnectionAction.mockResolvedValue({ status: "deleted" });
  testRpcConnectionAction.mockResolvedValue({ status: "tested", ok: true, failureCode: null });
});

afterEach(cleanup);

describe("RpcByokSection", () => {
  it("keeps the credential form collapsed until asked for", async () => {
    const user = userEvent.setup();
    renderSection();

    const toggle = screen.getByRole("button", { name: "Add connection" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // A page that is mostly status should not sit with a secret field open.
    expect(screen.queryByRole("button", { name: "Save connection" })).toBeNull();

    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save connection" })).toBeTruthy();
  });

  it("collapses again once the credential is saved", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    await user.type(screen.getByRole("textbox", { name: /Connection name/i }), "Prod");
    await user.type(screen.getByLabelText(/API key/i), "tenant-key-9999");
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    expect(screen.queryByRole("button", { name: "Save connection" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add connection" })).toBeTruthy();
  });

  it("says the organization is on SDP's credentials when it has none of its own", () => {
    renderSection();
    expect(screen.getByText(/running on SDP's/)).toBeTruthy();
  });

  it("submits the key the organization typed", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    await user.type(screen.getByRole("textbox", { name: /Connection name/i }), "Prod");
    // A password input has no textbox role, so it is reached by label text.
    await user.type(screen.getByLabelText(/API key/i), "tenant-key-9999");
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    expect(submitRpcConnectionAction).toHaveBeenCalledTimes(1);
    const sent = submitRpcConnectionAction.mock.calls[0][0] as FormData;
    expect(sent.get("apiKey")).toBe("tenant-key-9999");
    expect(sent.get("provider")).toBe("helius");
    expect(sent.get("scope")).toBe("project");
    // The project decides the network now, so the form must not send one
    // that could disagree with it (HOO-1221).
    expect(sent.get("network")).toBeNull();
  });

  it("clears the key field after a successful save so it is never re-shown", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    await user.type(screen.getByRole("textbox", { name: /Connection name/i }), "Prod");
    const key = screen.getByLabelText(/API key/i) as HTMLInputElement;
    await user.type(key, "tenant-key-9999");
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    expect(key.value).toBe("");
  });

  it("does not ask for an endpoint a provider publishes for every account", async () => {
    const user = userEvent.setup();
    renderSection({ provider: "helius" });

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    expect(screen.queryByRole("textbox", { name: /Endpoint URL/i })).toBeNull();
  });

  it("asks for an endpoint when the provider issues an account-specific one", async () => {
    const user = userEvent.setup();
    renderSection({ provider: "quicknode" });

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    expect(screen.getByRole("textbox", { name: /Endpoint URL/i })).toBeTruthy();
  });

  it("lets the key be revealed so a typo is catchable before saving", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    const key = screen.getByLabelText(/API key/i) as HTMLInputElement;
    expect(key.type).toBe("password");

    await user.click(screen.getByRole("button", { name: "Reveal key" }));
    expect(key.type).toBe("text");

    await user.click(screen.getByRole("button", { name: "Hide key" }));
    expect(key.type).toBe("password");
  });

  it("masks a stored credential down to a host and suffix", () => {
    renderSection({ connections: [connection()] });
    expect(screen.getByText(/tenant\.example/)).toBeTruthy();
    expect(screen.getByText(/1234/)).toBeTruthy();
    expect(screen.getByText("Serving traffic")).toBeTruthy();
  });

  it("offers activation for a connection that is not yet serving", async () => {
    const user = userEvent.setup();
    renderSection({ connections: [connection({ status: "pending", isDefault: false })] });

    await user.click(screen.getByRole("button", { name: "Use this connection" }));
    expect(activateRpcConnectionAction).toHaveBeenCalledTimes(1);
  });

  it("tells the tenant an organization-scoped connection is not routing", () => {
    // Made before HOO-1226. The relay refuses to resolve it, so offering
    // activation here would report success over a connection carrying nothing.
    renderSection({
      connections: [connection({ scope: "organization", projectId: null, isDefault: false })],
    });

    expect(screen.getByText(/not routing traffic/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this connection" })).toBeNull();
  });

  it("still lets a stranded organization connection be deactivated", () => {
    // The hold-to-confirm behaviour itself is covered by the button's own
    // tests; what matters here is that the way out is still offered.
    renderSection({
      connections: [connection({ scope: "organization", projectId: null, isDefault: false })],
    });

    expect(screen.getByRole("button", { name: /Deactivate/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Test" })).toBeNull();
  });

  it("offers delete on a deactivated connection and nothing that would error", async () => {
    const user = userEvent.setup();
    renderSection({
      connections: [connection({ status: "deactivated", isDefault: false })],
    });

    expect(screen.queryByRole("button", { name: "Use this connection" })).toBeNull();
    expect(screen.getByText(/stored key was destroyed/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteRpcConnectionAction).toHaveBeenCalledTimes(1);
  });

  it("asks for the replacement key instead of making people re-add", async () => {
    const user = userEvent.setup();
    renderSection({ connections: [connection()] });

    await user.click(screen.getByRole("button", { name: "Rotate key" }));
    await user.type(screen.getByLabelText("New API key"), "tenant-key-rotated");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    const sent = rotateRpcConnectionAction.mock.calls[0][0] as FormData;
    expect(sent.get("apiKey")).toBe("tenant-key-rotated");
    expect(sent.get("connectionId")).toBe("rconn_1");
  });

  it("offers the organization-wide credential mode to an admin", async () => {
    const user = userEvent.setup();
    renderSection({ connections: [connection()], credentialMode: "managed" });

    await user.click(screen.getByRole("switch", { name: /own credentials/ }));

    const sent = setRpcCredentialModeAction.mock.calls[0][0] as FormData;
    expect(sent.get("mode")).toBe("byok");
  });

  it("says so when the organization is on its own keys with nothing serving", () => {
    // Deleting the last connection while the toggle is on leaves every RPC
    // call failing, and nothing else on the page would say why.
    renderSection({ connections: [], credentialMode: "byok", liveConnectionCount: 0 });
    expect(screen.getByText(/Every RPC call for this organization is failing/)).toBeTruthy();
  });

  it("warns that deactivating the last one stops RPC rather than falling back", () => {
    renderSection({
      connections: [connection()],
      credentialMode: "byok",
      liveConnectionCount: 1,
    });
    expect(screen.getByText(/stops RPC rather than falling back/)).toBeTruthy();
  });

  it("drops a check result once the row is acted on", async () => {
    const user = userEvent.setup();
    renderSection({ connections: [connection({ status: "pending", isDefault: false })] });

    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText(/Reached the provider just now/)).toBeTruthy();

    // The check described the connection as it was; activating changes it.
    await user.click(screen.getByRole("button", { name: "Use this connection" }));
    expect(screen.queryByText(/Reached the provider just now/)).toBeNull();
  });

  it("hides the credential mode control when it could not be read", () => {
    // Showing "SDP-managed" at an organization that is actually on its own
    // keys is the kind of wrong somebody acts on.
    renderSection({ connections: [connection()], credentialMode: null });
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("hides the add form once the project already has a connection", () => {
    // One per project for now (HOO-1227), so the way to change it is rotation.
    renderSection({ connections: [connection()] });

    expect(screen.queryByRole("button", { name: "Add connection" })).toBeNull();
    expect(screen.getByText(/A project routes through one connection/)).toBeTruthy();
  });

  it("closes the form when another provider already holds this project", async () => {
    // A project routes through one connection whatever the provider, so
    // offering Add here produced a form that could only ever 409 (HOO-1227).
    renderSection({ connections: [], projectConnectionProvider: "helius" });

    expect(screen.queryByRole("button", { name: "Add connection" })).toBeNull();
    // The display name, not the raw id: the page showed "alchemy" beside its
    // own "Alchemy" row before this went through rpcProviderLabel.
    expect(screen.getByText(/already routes through Helius/)).toBeTruthy();
  });

  it("does not claim the organization runs on SDP's when the project has its own connection", () => {
    // The empty state is provider-scoped, so "running on SDP's" was false
    // exactly when another provider held this project's connection.
    renderSection({ connections: [], projectConnectionProvider: "alchemy" });

    expect(screen.queryByText(/running on SDP's/)).toBeNull();
    expect(screen.getByText(/runs on your own Alchemy connection/)).toBeTruthy();
  });

  it("does not tell an admin that only admins can add credentials", () => {
    // canManage is true here, so the admin-only note is addressed to the
    // wrong reader; the reason the form is closed is stated above it.
    renderSection({ connections: [], projectConnectionProvider: "alchemy" });

    expect(screen.queryByText(/Only organization administrators/)).toBeNull();
  });

  it("still offers add when the only rows are stranded or withdrawn", () => {
    renderSection({
      connections: [
        connection({ scope: "organization", projectId: null, isDefault: false }),
        connection({ id: "rconn_2", status: "deactivated", isDefault: false }),
      ],
    });

    expect(screen.getByRole("button", { name: "Add connection" })).toBeTruthy();
  });

  it("warns when the connection about to be deactivated is the only one", () => {
    renderSection({ connections: [connection()] });
    expect(screen.getByText(/only connection routing this project/)).toBeTruthy();
  });

  it("gives a non-admin the connections but no controls", () => {
    renderSection({ canManage: false, connections: [connection()] });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Only organization administrators/)).toBeTruthy();
  });

  it("surfaces a redacted failure code from a manual test, not a provider response", async () => {
    const user = userEvent.setup();
    testRpcConnectionAction.mockResolvedValue({
      status: "tested",
      ok: false,
      failureCode: "provider_rejected_credentials",
    });
    renderSection({ connections: [connection({ status: "failed", isDefault: false })] });

    await user.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByText("provider_rejected_credentials")).toBeTruthy();
  });

  it("reports a passing check without writing anything down", async () => {
    const user = userEvent.setup();
    testRpcConnectionAction.mockResolvedValue({ status: "tested", ok: true, failureCode: null });
    renderSection({ connections: [connection()] });

    await user.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByText(/Reached the provider just now/)).toBeTruthy();
  });

  it("says the credentials could not be read rather than claiming there are none", () => {
    // An empty array is a claim; a failed read is not. Telling an organization
    // with stored credentials that it has none is the worse of the two.
    renderSection({ connections: null });

    expect(screen.getByText(/could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/running on SDP's/)).toBeNull();
  });

  it("tells a member the list is admin-only instead of asking them to reload", () => {
    // The internal routes are org:admin for reads too, so a member's request
    // was always going to 403. Rendering that as a failed read told everyone
    // below admin to reload a page that could never load for them.
    renderSection({ canManage: false, connections: "restricted" });

    expect(screen.getByText(/Only organization administrators can see/)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(screen.queryByText(/running on SDP's/)).toBeNull();
  });
});
