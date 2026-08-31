// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
const switchRpcProviderAction = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock("./rpc-connection-actions", () => ({
  switchRpcProviderAction: (formData: FormData) => switchRpcProviderAction(formData),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    loading: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));
// The relay probe is shared code exercised by the settings form; the panel only
// has to decide whether to offer it.
vi.mock("@/lib/rpc-connection", () => ({
  RpcTestResultPanel: () => <div data-testid="rpc-test-result" />,
  runRpcProviderTest: vi.fn(async () => ({
    status: "success" as const,
    message: "ok",
    requestedProvider: "helius" as const,
  })),
}));

import { toast } from "sonner";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { runRpcProviderTest } from "@/lib/rpc-connection";
import { RpcConnectionPanel } from "./rpc-connection-panel";

function renderPanel(props: Partial<ComponentProps<typeof RpcConnectionPanel>> = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
  return render(
    <RpcConnectionPanel
      activeProvider="helius"
      canManage
      isEnabledInDeployment
      organizationId="org_1"
      provider="helius"
      status="active"
      {...props}
    />,
    { wrapper }
  );
}

beforeEach(() => {
  refresh.mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  switchRpcProviderAction.mockReset();
  switchRpcProviderAction.mockResolvedValue({
    status: "success",
    provider: "alchemy",
    usesOwnCredential: false,
  });
});

afterEach(cleanup);

describe("RpcConnectionPanel", () => {
  it("offers the relay test only on the provider the organization actually runs", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this provider" })).toBeNull();
    expect(screen.getByText(/runs through this provider/)).toBeTruthy();
  });

  it("warns rather than errors when another provider answered the test", async () => {
    // The result panel renders this in amber next to a 200 OK. A red error
    // toast for the same event put two severities on screen at once.
    vi.mocked(runRpcProviderTest).mockResolvedValueOnce({
      status: "error",
      reason: "mismatch",
      message: "Alchemy answered this test, not Helius.",
      requestedProvider: "helius",
      resolvedProvider: "alchemy",
      upstreamStatus: 200,
    });

    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(toast.warning).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("still raises an error toast when the upstream genuinely failed", async () => {
    vi.mocked(runRpcProviderTest).mockResolvedValueOnce({
      status: "error",
      reason: "upstream",
      message: "RPC upstream returned 502 Bad Gateway.",
      requestedProvider: "helius",
      resolvedProvider: "helius",
      upstreamStatus: 502,
    });

    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(toast.error).toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("offers the switch while another provider's own key is serving, and disclaims nothing", () => {
    // The switch moves the credential too now, so the note that used to warn
    // it would change nothing describes behaviour the button no longer has.
    renderPanel({
      provider: "helius",
      activeProvider: "alchemy",
      servingProvider: "alchemy",
      status: "available",
    });

    expect(screen.getByRole("button", { name: "Use this provider" })).toBeTruthy();
    expect(screen.queryByText(/will not change what serves this project/)).toBeNull();
  });

  it("offers no switch on the provider that is already serving", () => {
    // The old gate asked whether this was the organization's selection, which
    // a serving tenant key overrides. That put "Use this provider" on a page
    // whose own badge read Connected.
    renderPanel({ provider: "alchemy", activeProvider: "helius", servingProvider: "alchemy" });

    expect(screen.queryByRole("button", { name: "Use this provider" })).toBeNull();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeTruthy();
  });

  it("offers the switch for a provider this deployment holds no URL for, given their own key", () => {
    // BYOK runs on the tenant's endpoint, so deployment availability decides
    // nothing about whether they can move to it.
    renderPanel({
      provider: "nodit",
      activeProvider: "helius",
      servingProvider: "alchemy",
      isEnabledInDeployment: false,
      hasOwnKey: true,
      status: "available",
    });

    expect(screen.getByRole("button", { name: "Use this provider" })).toBeTruthy();
  });

  it("names the tenant's own key when this provider serves on it", () => {
    // Org selection and project connection can name the same vendor. Same
    // logo, different bill, and the page used to claim SDP's account.
    renderPanel({ provider: "alchemy", activeProvider: "alchemy", servingProvider: "alchemy" });

    expect(screen.queryByText(/runs through this provider/)).toBeNull();
    expect(screen.getByText(/your own connection with this provider/)).toBeTruthy();
  });

  it("does not claim traffic runs here when the project's own connection wins", () => {
    // A tenant connection outranks the organization's selection, so the
    // selected provider can be serving nothing at all. Claiming otherwise is
    // what made a healthy Alchemy connection read as a broken Helius one.
    // Keyed on what actually routes: a pending row elsewhere does not take
    // the project off the platform selection, an active one does.
    renderPanel({ servingProvider: "alchemy" });

    expect(screen.queryByText(/runs through this provider/)).toBeNull();
    expect(screen.getByText(/runs on your own Alchemy connection instead/)).toBeTruthy();
  });

  it("names the active provider on a page for a different one", () => {
    renderPanel({ provider: "alchemy", status: "available" });
    // Reading Alchemy's page must not leave you guessing what is live.
    expect(screen.getByText("This organization currently runs on Helius.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this provider" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  });

  it("switches the whole project onto the provider whose page this is", async () => {
    const user = userEvent.setup();
    renderPanel({ provider: "alchemy", status: "available" });

    await user.click(screen.getByRole("button", { name: "Use this provider" }));

    // One action covering both halves. Writing only the organization setting
    // left a tenant connection still serving the old provider, so the button
    // reported success and changed nothing anyone could observe.
    expect(switchRpcProviderAction).toHaveBeenCalledTimes(1);
    const formData = switchRpcProviderAction.mock.calls[0][0] as FormData;
    expect(formData.get("provider")).toBe("alchemy");
    expect(formData.get("organizationId")).toBe("org_1");
    // The server render owns the active provider; without a refresh the page
    // would keep claiming the old one is live.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("says which account is answering after the switch", async () => {
    switchRpcProviderAction.mockResolvedValue({
      status: "success",
      provider: "alchemy",
      usesOwnCredential: true,
    });
    const user = userEvent.setup();
    renderPanel({ provider: "alchemy", status: "available" });

    await user.click(screen.getByRole("button", { name: "Use this provider" }));

    // Same logo, different bill. "Switched to Alchemy" alone never said whose
    // Alchemy account is about to be charged.
    expect(vi.mocked(toast.success).mock.calls[0]?.[1]?.description).toMatch(
      /your own Alchemy key/
    );
  });

  it("offers the way back to SDP RPC from a vendor page", async () => {
    const user = userEvent.setup();
    // The catalog lists `default` alongside the vendors, so this page exists
    // and is the only route back off a vendor now that the Settings dropdown
    // is gone. Without it an organization on Helius was stuck there.
    renderPanel({ provider: "default", status: "available" });

    expect(screen.getByText("This organization currently runs on Helius.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Use this provider" }));

    const formData = switchRpcProviderAction.mock.calls[0][0] as FormData;
    expect(formData.get("provider")).toBe("default");
  });

  it("gives a non-admin the state but no way to change it", () => {
    renderPanel({ canManage: false, provider: "alchemy", status: "available" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/only admins can change them/)).toBeTruthy();
  });

  it("does not let a read-only member invoke the relay probe", () => {
    // Testing reaches an upstream provider; a member who may only read state
    // must not be able to spend that call.
    renderPanel({ canManage: false });
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  });

  it("says the saved provider is stranded instead of offering a dead test", () => {
    // The catalog marks the saved provider active whatever the deployment
    // holds, so without this the page offers a probe that silently measures a
    // different provider.
    renderPanel({ isEnabledInDeployment: false });
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
    expect(screen.getByText(/falling back to another one/)).toBeTruthy();
    // ...and must not simultaneously claim traffic runs through it.
    expect(screen.queryByText(/runs through this provider/)).toBeNull();
    expect(screen.getByText("This organization is set to use this provider.")).toBeTruthy();
  });

  it("explains an unconfigured provider instead of offering a dead switch", () => {
    // `not_configured` is derived from the deployment holding no URL, so the
    // two have to agree here; passing them apart described a page the loader
    // cannot produce.
    renderPanel({ provider: "triton", status: "not_configured", isEnabledInDeployment: false });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/holds no endpoint/)).toBeTruthy();
  });

  it("does not switch when the save fails", async () => {
    switchRpcProviderAction.mockResolvedValue({
      status: "error",
      message: "nope",
    });
    const user = userEvent.setup();
    renderPanel({ provider: "alchemy", status: "available" });

    await user.click(screen.getByRole("button", { name: "Use this provider" }));

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByText("This organization currently runs on Helius.")).toBeTruthy();
  });
});
