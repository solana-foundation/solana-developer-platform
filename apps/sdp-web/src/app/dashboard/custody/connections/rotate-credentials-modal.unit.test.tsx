// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
// Keep the modal, action and API client real; supply only the request host context.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ orgId: "org_test", getToken: async () => "test-token" }),
}));

import { ConnectionCredentialsSection } from "./connection-credentials-section";
import type { CustodyCredentialLifecycle } from "./connection-detail.data";
import { RotateCredentialsModal } from "./rotate-credentials-modal";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  refresh.mockClear();
});

const lifecycle: CustodyCredentialLifecycle = {
  providerCredential: {
    id: "pcred_original",
    provider: "privy",
    label: "Privy production app",
    scope: "project",
    projectId: "prj_1",
    status: "active",
    createdAt: "2026-09-09T14:20:00.000Z",
    displayMetadata: { appIdSuffix: "9f2a" },
    source: "stored",
  },
  rotationCandidate: null,
  impact: {
    projects: [{ id: "prj_1", name: "Acme Payments" }],
    connections: [{ id: "cconn_1", projectId: "prj_1", status: "active" }],
  },
  rollback: null,
};

function modal(onClose: () => void, currentLifecycle = lifecycle, canRotate = true) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <RotateCredentialsModal
        isOpen
        onClose={onClose}
        lifecycle={currentLifecycle}
        provider="privy"
        connectionId="cconn_1"
        canRotate={canRotate}
      />
    </I18nProvider>
  );
}

function mockApi() {
  vi.stubEnv("SDP_API_BASE_URL", "https://api.example.test");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const rotation = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/v1/projects")) {
        return Response.json({ data: { projects: [{ id: "prj_1", slug: "default-sandbox" }] } });
      }
      if (String(url).endsWith("/rotate")) {
        return rotation(String(url), init);
      }
      throw new Error(`Unexpected API request: ${url}`);
    })
  );
  return rotation;
}

async function submitCredentials(appSecret = "test-app-secret") {
  await userEvent.type(screen.getByLabelText("Privy app ID"), "test-app-id");
  await userEvent.type(screen.getByLabelText("New Privy app secret"), appSecret);
  await userEvent.click(screen.getByRole("button", { name: "Rotate for 1 connections" }));
}

describe("rotation recovery", () => {
  it.each([408, 429, 503, "transport", "retry_unknown"])(
    "retries %s with the original fields, key and credential after props refresh",
    async (outcome) => {
      const rotation = mockApi();
      if (outcome === "transport") {
        rotation.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      } else {
        rotation.mockResolvedValueOnce(
          typeof outcome === "number"
            ? Response.json({ error: { message: "Timed out" } }, { status: outcome })
            : Response.json({
                data: {
                  providerCredential: { id: "pcred_candidate" },
                  rotation: { status: outcome },
                },
              })
        );
      }
      rotation.mockResolvedValueOnce(
        Response.json({
          data: { providerCredential: { id: "pcred_new" }, rotation: { status: "success" } },
        })
      );
      const onClose = vi.fn();
      const view = render(modal(onClose));
      await submitCredentials();
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

      view.rerender(
        modal(onClose, {
          ...lifecycle,
          providerCredential: { ...lifecycle.providerCredential, id: "pcred_new" },
        })
      );
      expect(screen.getByLabelText("Privy app ID")).toHaveProperty("disabled", true);
      expect(screen.getByLabelText("New Privy app secret")).toHaveProperty("disabled", true);
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
      await userEvent.keyboard("{Escape}");
      expect(onClose).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(rotation).toHaveBeenCalledTimes(2);
      const first = rotation.mock.calls[0];
      const retry = rotation.mock.calls[1];
      expect(first?.[0]).toBe(
        "https://api.example.test/internal/dashboard/custody/provider-credentials/pcred_original/rotate"
      );
      expect(retry?.[0]).toBe(first?.[0]);
      expect(first?.[1]?.body).toBe(
        JSON.stringify({ fields: { appId: "test-app-id", appSecret: "test-app-secret" } })
      );
      expect(retry?.[1]?.body).toBe(first?.[1]?.body);
      const originalKey = new Headers(first?.[1]?.headers).get("Idempotency-Key");
      expect(originalKey).toBeTruthy();
      expect(new Headers(retry?.[1]?.headers).get("Idempotency-Key")).toBe(originalKey);
      expect(screen.getByLabelText("New Privy app secret")).toHaveProperty("value", "");
    }
  );

  it.each([null, "restricted"] as const)(
    "keeps an unresolved rotation open when refreshed lifecycle is %s",
    async (unavailableLifecycle) => {
      const rotation = mockApi();
      rotation.mockResolvedValueOnce(
        Response.json({ error: { message: "Timed out" } }, { status: 503 })
      );
      rotation.mockResolvedValueOnce(
        Response.json({
          data: { providerCredential: { id: "pcred_new" }, rotation: { status: "success" } },
        })
      );
      function section(currentLifecycle: CustodyCredentialLifecycle | "restricted" | null) {
        return (
          <I18nProvider locale="en" messages={getMessages("en")}>
            <ConnectionCredentialsSection
              lifecycle={currentLifecycle}
              connection={{
                id: "cconn_1",
                provider: "privy",
                label: "Production signing",
                status: "active",
                completion: null,
                isDefault: true,
                canComplete: false,
                canReplaceCredentials: false,
                canCancel: false,
              }}
              provider="privy"
              canManageCustody
            />
          </I18nProvider>
        );
      }
      const view = render(section(lifecycle));
      await userEvent.click(screen.getByRole("button", { name: "Rotate credentials" }));
      await submitCredentials();
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

      view.rerender(section(unavailableLifecycle));
      expect(screen.getByRole("dialog", { name: "Rotate credentials" })).toBeTruthy();
      view.rerender(
        section({
          ...lifecycle,
          providerCredential: { ...lifecycle.providerCredential, status: "retired" },
        })
      );
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(rotation).toHaveBeenCalledTimes(2);
      expect(rotation.mock.calls[1]?.[0]).toBe(rotation.mock.calls[0]?.[0]);
      expect(rotation.mock.calls[1]?.[1]?.body).toBe(rotation.mock.calls[0]?.[1]?.body);
    }
  );

  it.each([400, 403, "failed"])(
    "starts a corrected intent with a new key only after %s refusal",
    async (outcome) => {
      const rotation = mockApi();
      rotation.mockResolvedValueOnce(
        typeof outcome === "number"
          ? Response.json({ error: { message: "Invalid credentials" } }, { status: outcome })
          : Response.json({
              data: {
                providerCredential: { id: "pcred_candidate" },
                rotation: { status: outcome, code: "invalid_credentials" },
              },
            })
      );
      rotation.mockResolvedValueOnce(
        Response.json({
          data: { providerCredential: { id: "pcred_new" }, rotation: { status: "success" } },
        })
      );
      const onClose = vi.fn();
      render(modal(onClose));
      await submitCredentials();
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      expect(screen.getByLabelText("New Privy app secret")).toHaveProperty("value", "");
      expect(screen.getByLabelText("New Privy app secret")).toHaveProperty("disabled", false);
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", false);
      expect(onClose).not.toHaveBeenCalled();

      await userEvent.type(screen.getByLabelText("New Privy app secret"), "corrected-secret");
      await userEvent.click(screen.getByRole("button", { name: "Rotate for 1 connections" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(rotation).toHaveBeenCalledTimes(2);
      const originalKey = new Headers(rotation.mock.calls[0]?.[1]?.headers).get("Idempotency-Key");
      const corrected = rotation.mock.calls[1]?.[1];
      expect(new Headers(corrected?.headers).get("Idempotency-Key")).not.toBe(originalKey);
      expect(corrected?.body).toBe(
        JSON.stringify({ fields: { appId: "test-app-id", appSecret: "corrected-secret" } })
      );
    }
  );

  it("blocks editing and closing while the first rotation is in flight", async () => {
    const rotation = mockApi();
    let resolveRotation: ((response: Response) => void) | undefined;
    rotation.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRotation = resolve;
      })
    );
    const onClose = vi.fn();
    render(modal(onClose));
    await submitCredentials();
    await waitFor(() => expect(rotation).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Privy app ID")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("New Privy app secret")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).not.toHaveBeenCalled();
    resolveRotation?.(
      Response.json({
        data: { providerCredential: { id: "pcred_new" }, rotation: { status: "success" } },
      })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("allows only the unresolved retry after rotation permission changes", async () => {
    const rotation = mockApi();
    rotation.mockResolvedValueOnce(
      Response.json({ error: { message: "Timed out" } }, { status: 503 })
    );
    rotation.mockResolvedValueOnce(
      Response.json({
        data: {
          providerCredential: { id: "pcred_candidate" },
          rotation: { status: "failed", code: "invalid_credentials" },
        },
      })
    );
    const onClose = vi.fn();
    const view = render(modal(onClose));
    await submitCredentials();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    view.rerender(modal(onClose, lifecycle, false));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("New Privy app secret")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Privy app ID")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Rotate for 1 connections" })).toHaveProperty(
      "disabled",
      true
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(rotation).toHaveBeenCalledTimes(2);
  });

  it.each([403, 409])(
    "keeps the original unknown attempt after a replay receives HTTP %s",
    async (status) => {
      const rotation = mockApi();
      rotation.mockResolvedValueOnce(
        Response.json({ error: { message: "Timed out" } }, { status: 503 })
      );
      rotation.mockResolvedValueOnce(
        Response.json({ error: { message: "Replay refused" } }, { status })
      );
      rotation.mockResolvedValueOnce(
        Response.json({
          data: { providerCredential: { id: "pcred_new" }, rotation: { status: "success" } },
        })
      );
      const onClose = vi.fn();
      render(modal(onClose));
      await submitCredentials();
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));

      expect(screen.getByLabelText("New Privy app secret")).toHaveProperty(
        "value",
        "test-app-secret"
      );
      expect(screen.getByLabelText("New Privy app secret")).toHaveProperty("disabled", true);
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
      expect(onClose).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(rotation).toHaveBeenCalledTimes(3);
      const first = rotation.mock.calls[0];
      const originalKey = new Headers(first?.[1]?.headers).get("Idempotency-Key");
      expect(originalKey).toBeTruthy();
      for (const retry of rotation.mock.calls.slice(1)) {
        expect(retry[0]).toBe(first?.[0]);
        expect(retry[1]?.body).toBe(first?.[1]?.body);
        expect(new Headers(retry[1]?.headers).get("Idempotency-Key")).toBe(originalKey);
      }
    }
  );
});
