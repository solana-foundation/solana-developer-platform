// @vitest-environment jsdom

import { type PaymentWalletPolicy, SOL_MINT } from "@sdp/types";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages, loadMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import {
  clearPolicyDraft,
  createPolicyAuthoringState,
  loadPolicyDraft,
  policyDraftStorageKey,
  savePolicyDraft,
} from "./wallet-policy-authoring";
import { WalletPolicyStartingProfileFlow } from "./wallet-policy-starting-profile-flow";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: "sandbox" }),
}));

const wallet = {
  id: "cwlt_selected",
  walletId: "provider_selected",
  publicKey: "11111111111111111111111111111111",
  label: "Selected wallet",
  provider: "privy",
};
const policy: PaymentWalletPolicy = {
  custodyWalletId: wallet.id,
  walletId: wallet.walletId,
  defaultAction: "allow",
  rules: [],
  controlProfile: null,
};

function ui(
  policyError: string | null = null,
  target = wallet,
  projectId = "prj_test_sandbox",
  locale: "en" | "es" = "en",
  messages = getMessages("en")
) {
  return (
    <I18nProvider locale={locale} messages={messages}>
      <SWRConfig value={{ provider: () => new Map() }}>
        <WalletPolicyStartingProfileFlow
          key={`${projectId}:${target.id}`}
          projectId={projectId}
          wallet={target}
          walletAssets={[]}
          issuedTokens={[]}
          initialPolicy={policy}
          policyError={policyError}
          complianceScreeningEnabled={false}
        />
      </SWRConfig>
    </I18nProvider>
  );
}

beforeEach(() => {
  resetDashboardNavigation();
  setDashboardUrl("/dashboard/prj_test_sandbox/wallets/cwlt_selected/policy", {
    projectId: "prj_test_sandbox",
    walletId: wallet.id,
  });
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("wallet policy confirmation", () => {
  it("does not autosave restored legacy fields over a clear from another tab", async () => {
    const projectId = "prj_test_sandbox";
    const state = createPolicyAuthoringState(policy);
    state.defaultAction = "deny";
    window.localStorage.setItem(
      `sdp.wallet-policy-authoring.v1.${projectId}.${wallet.walletId}`,
      JSON.stringify({
        version: 1,
        projectId,
        walletId: wallet.walletId,
        step: "review",
        state,
        updatedAt: "2026-10-09T10:00:00.000Z",
      })
    );
    const view = render(ui());
    await view.findByRole("button", { name: "Activate controls" });
    expect(window.localStorage.getItem(policyDraftStorageKey(projectId, wallet.id))).toBeNull();
    clearPolicyDraft(window.localStorage, projectId, wallet.id, wallet.walletId);

    await new Promise((resolve) => window.setTimeout(resolve, 400));
    expect(loadPolicyDraft(window.localStorage, projectId, wallet.id).draft).toBeNull();
  });

  it("autosaves edits and an undo after restoration", async () => {
    const projectId = "prj_test_sandbox";
    const state = createPolicyAuthoringState(policy);
    state.categories = ["limits"];
    state.limits = [{ asset: SOL_MINT, max: "3" }];
    window.localStorage.setItem(
      `sdp.wallet-policy-authoring.v1.${projectId}.${wallet.walletId}`,
      JSON.stringify({
        version: 1,
        projectId,
        walletId: wallet.walletId,
        step: "limits-assets",
        state,
        updatedAt: "2026-10-09T10:00:00.000Z",
      })
    );
    const view = render(ui());
    const amount = await view.findByDisplayValue("3");
    fireEvent.change(amount, { target: { value: "5" } });
    await waitFor(() =>
      expect(
        loadPolicyDraft(window.localStorage, projectId, wallet.id).draft?.state.limits[0]?.max
      ).toBe("5")
    );
    fireEvent.change(amount, { target: { value: "3" } });
    await waitFor(() =>
      expect(
        loadPolicyDraft(window.localStorage, projectId, wallet.id).draft?.state.limits[0]?.max
      ).toBe("3")
    );
    fireEvent.click(view.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(loadPolicyDraft(window.localStorage, projectId, wallet.id).draft?.step).toBe(
        "destinations-operations"
      )
    );
  });

  it("restores an exact-wallet draft for review without submitting it", async () => {
    const state = createPolicyAuthoringState(policy);
    state.defaultAction = "deny";
    savePolicyDraft(window.localStorage, {
      version: 2,
      projectId: "prj_test_sandbox",
      custodyWalletId: wallet.id,
      step: "review",
      state,
      updatedAt: "2026-10-09T10:00:00.000Z",
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    const view = render(ui());

    await waitFor(() =>
      expect(view.getByRole("button", { name: "Activate controls" }).hasAttribute("disabled")).toBe(
        false
      )
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks activation after a failed policy read while keeping restored edits", async () => {
    const state = createPolicyAuthoringState(policy);
    state.defaultAction = "deny";
    savePolicyDraft(window.localStorage, {
      version: 2,
      projectId: "prj_test_sandbox",
      custodyWalletId: wallet.id,
      step: "review",
      state,
      updatedAt: "2026-10-09T10:00:00.000Z",
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    const view = render(ui("Controls are unavailable"));

    await waitFor(() =>
      expect(view.getByRole("button", { name: "Activate controls" }).hasAttribute("disabled")).toBe(
        true
      )
    );
    expect(view.getByText("Controls are unavailable")).toBeTruthy();
    expect(view.queryByText("Not activated")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      loadPolicyDraft(window.localStorage, "prj_test_sandbox", wallet.id).draft?.state.defaultAction
    ).toBe("deny");
  });

  it.each(["wallet", "project"])(
    "resets editing state when the exact %s target changes",
    async (change) => {
      const state = createPolicyAuthoringState(policy);
      state.defaultAction = "deny";
      savePolicyDraft(window.localStorage, {
        version: 2,
        projectId: "prj_test_sandbox",
        custodyWalletId: wallet.id,
        step: "review",
        state,
        updatedAt: "2026-10-09T10:00:00.000Z",
      });
      const view = render(ui());
      await waitFor(() => expect(view.getByRole("status").textContent).toBe("Step 4 of 4"));

      const target = change === "wallet" ? { ...wallet, id: "cwlt_other" } : wallet;
      const projectId = change === "project" ? "prj_other_sandbox" : "prj_test_sandbox";
      setDashboardUrl(`/dashboard/${projectId}/wallets/${target.id}/policy`, {
        projectId,
        walletId: target.id,
      });
      view.rerender(ui(null, target, projectId));
      await waitFor(() => expect(view.getByRole("status").textContent).toBe("Step 1 of 4"));
      expect(view.queryByRole("button", { name: "Activate controls" })).toBeNull();
      expect(loadPolicyDraft(window.localStorage, projectId, target.id).draft).toBeNull();
    }
  );

  it("retains unsent edits after a failed policy commit", async () => {
    const state = createPolicyAuthoringState(policy);
    state.defaultAction = "deny";
    savePolicyDraft(window.localStorage, {
      version: 2,
      projectId: "prj_test_sandbox",
      custodyWalletId: wallet.id,
      step: "review",
      state,
      updatedAt: "2026-10-09T10:00:00.000Z",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "Please retry" },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      )
    );
    const error = vi.spyOn(toast, "error");
    const view = render(ui());
    fireEvent.click(await view.findByRole("button", { name: "Activate controls" }));
    await waitFor(() => expect(view.getByRole("dialog", { name: "Review changes" })).toBeTruthy());
    fireEvent.click(
      within(view.getByRole("dialog", { name: "Review changes" })).getByRole("button", {
        name: "Activate controls",
      })
    );

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Activation failed.", expect.any(Object))
    );
    expect(view.getByRole("dialog", { name: "Review changes" })).toBeTruthy();
    expect(
      loadPolicyDraft(window.localStorage, "prj_test_sandbox", wallet.id).draft?.state.defaultAction
    ).toBe("deny");
  });

  it("keeps current unsaved edits when the display language changes", async () => {
    const spanish = await loadMessages("es");
    const state = createPolicyAuthoringState(policy);
    state.categories = ["limits"];
    state.limits = [{ asset: SOL_MINT, max: "3" }];
    savePolicyDraft(window.localStorage, {
      version: 2,
      projectId: "prj_test_sandbox",
      custodyWalletId: wallet.id,
      step: "limits-assets",
      state,
      updatedAt: "2026-10-09T10:00:00.000Z",
    });
    const view = render(ui());
    const amount = await view.findByDisplayValue("3");
    fireEvent.change(amount, { target: { value: "5" } });
    view.rerender(ui(null, wallet, "prj_test_sandbox", "es", spanish));

    expect(view.getByDisplayValue("5")).toBeTruthy();
  });

  it("reports a successful policy commit separately from failed browser cleanup", async () => {
    const state = createPolicyAuthoringState(policy);
    state.defaultAction = "deny";
    savePolicyDraft(window.localStorage, {
      version: 2,
      projectId: "prj_test_sandbox",
      custodyWalletId: wallet.id,
      step: "review",
      state,
      updatedAt: "2026-10-09T10:00:00.000Z",
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { policy: { ...policy, defaultAction: "deny" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const warning = vi.spyOn(toast, "warning");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("Storage refused cleanup");
    });
    const view = render(ui());
    fireEvent.click(await view.findByRole("button", { name: "Activate controls" }));
    await waitFor(() => expect(view.getByRole("dialog", { name: "Review changes" })).toBeTruthy());
    fireEvent.click(
      within(view.getByRole("dialog", { name: "Review changes" })).getByRole("button", {
        name: "Activate controls",
      })
    );

    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Wallet controls active.", expect.any(Object))
    );
    expect(error).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/dashboard/payments/wallets/cwlt_selected/policies");
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    expect(loadPolicyDraft(window.localStorage, "prj_test_sandbox", wallet.id).draft).toBeNull();
  });
});
