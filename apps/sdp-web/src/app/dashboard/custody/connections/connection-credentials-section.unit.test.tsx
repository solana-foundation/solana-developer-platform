// @vitest-environment jsdom

import { cleanup, render as renderDOM, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

// Supply the Next/Clerk request context; the card, dialogs, actions and API client stay real.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ orgId: "org_test", getToken: async () => "test-token" }),
}));

import { ConnectionCredentialsSection } from "./connection-credentials-section";
import type {
  CustodyCredentialLifecycle,
  CustodyInstallationConnection,
  LifecycleCredential,
} from "./connection-detail.data";
import { ROLLBACK_WINDOW_MS } from "./connection-detail.data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  refresh.mockClear();
});

function makeCredential(overrides: Partial<LifecycleCredential> = {}): LifecycleCredential {
  return {
    id: "pcred_current",
    provider: "privy",
    label: "Privy production app",
    scope: "project",
    projectId: "prj_1",
    status: "active",
    createdAt: "2026-09-09T14:20:00.000Z",
    displayMetadata: { appIdSuffix: "9f2a" },
    source: "stored",
    ...overrides,
  };
}

function makeConnection(
  overrides: Partial<CustodyInstallationConnection> = {}
): CustodyInstallationConnection {
  return {
    id: "cconn_1",
    provider: "privy",
    label: "Production signing",
    status: "active",
    completion: null,
    isDefault: true,
    canComplete: false,
    canReplaceCredentials: false,
    canCancel: false,
    ...overrides,
  };
}

function makeLifecycle(
  overrides: Partial<CustodyCredentialLifecycle> = {}
): CustodyCredentialLifecycle {
  return {
    providerCredential: makeCredential(),
    rotationCandidate: null,
    impact: {
      projects: [{ id: "prj_1", name: "Acme Payments" }],
      connections: [{ id: "cconn_1", projectId: "prj_1", status: "active" }],
    },
    rollback: null,
    ...overrides,
  };
}

function render({
  lifecycle,
  connection = makeConnection(),
  canManageCustody = true,
}: {
  lifecycle: CustodyCredentialLifecycle | "restricted" | null;
  connection?: CustodyInstallationConnection;
  canManageCustody?: boolean;
}): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ConnectionCredentialsSection
        lifecycle={lifecycle}
        connection={connection}
        provider="privy"
        canManageCustody={canManageCustody}
      />
    </I18nProvider>
  );
}

/** Whether the rendered button carrying this label is disabled. */
function buttonDisabled(html: string, label: string): boolean {
  const index = html.indexOf(label);
  expect(index, `expected a control labelled "${label}"`).toBeGreaterThan(-1);
  const opening = html.lastIndexOf("<button", index);
  return html.slice(opening, index).includes("disabled");
}

describe("credentials section", () => {
  it("shows only the masked App ID suffix, never a secret", () => {
    const html = render({ lifecycle: makeLifecycle() });
    expect(html).toContain("····9f2a");
    expect(html).not.toContain("appSecret");
  });

  describe("credentials supplied by the deployment", () => {
    const lifecycle = makeLifecycle({
      providerCredential: makeCredential({ source: "runtime" }),
    });

    it("labels where they are managed and that SDP does not track a version", () => {
      const html = render({ lifecycle });
      expect(html).toContain("Deployment configuration");
      expect(html).toContain("Not tracked by SDP");
      expect(html).toContain("take effect on restart");
    });

    it("leaves rotate and roll back visible but disabled, rather than hiding them", () => {
      const html = render({ lifecycle });

      // A control that vanishes reads as a bug; one that is visibly
      // unavailable teaches where the change is actually made.
      expect(buttonDisabled(html, "Rotate credentials")).toBe(true);
      expect(buttonDisabled(html, "Roll back")).toBe(true);
    });

    it("offers no credential deactivation, which only applies to a stored secret", () => {
      expect(render({ lifecycle })).not.toContain("Deactivate credentials");
    });
  });

  describe("a rotation waiting to settle", () => {
    const lifecycle = makeLifecycle({
      rotationCandidate: makeCredential({ id: "pcred_candidate", status: "pending" }),
      rollback: {
        providerCredential: makeCredential({ id: "pcred_previous", status: "retired" }),
        expiresAt: new Date(Date.now() + ROLLBACK_WINDOW_MS).toISOString(),
      },
    });

    it("says the current credentials are still in use and offers retry and cancel", () => {
      const html = render({ lifecycle });
      expect(html).toContain("A rotation is waiting to finish.");
      expect(html).toContain("still in use");
      expect(html).toContain("Cancel rotation");
    });

    it("blocks a second rotation and explains why rollback is unavailable", () => {
      const html = render({ lifecycle });
      expect(buttonDisabled(html, "Rotate credentials")).toBe(true);
      expect(html).toContain("Cancel the waiting rotation before rolling back.");
    });
  });

  it("offers credential deactivation after the last connection is deactivated", () => {
    const html = render({
      lifecycle: makeLifecycle({ impact: { connections: [], projects: [] } }),
      connection: makeConnection({ status: "deactivated" }),
    });

    expect(html).toContain("No connections use these credentials.");
    expect(html).not.toContain("Secret deleted");
    expect(buttonDisabled(html, "Deactivate credentials")).toBe(false);
    expect(buttonDisabled(html, "Rotate credentials")).toBe(true);
  });

  it.each([
    ["pending", false],
    ["creating", true],
  ] as const)(
    "handles a %s replacement after credential deactivation without offering retry",
    (status, cancellationDisabled) => {
      const html = render({
        lifecycle: makeLifecycle({
          providerCredential: makeCredential({ status: "deactivated" }),
          rotationCandidate: makeCredential({ id: "pcred_candidate", status }),
          impact: { connections: [], projects: [] },
        }),
        connection: makeConnection({ status: "deactivated" }),
      });

      expect(html).not.toContain("The current credentials are still in use.");
      expect(buttonDisabled(html, "Check again")).toBe(true);
      expect(buttonDisabled(html, "Cancel rotation")).toBe(cancellationDisabled);
    }
  );

  it("distinguishes a forbidden read from a failed one", () => {
    // Not permitted is a settled answer; a failed read is not, and inviting a
    // retry is only honest in the second case.
    expect(render({ lifecycle: "restricted" })).toContain("custody admin role");

    const failed = render({ lifecycle: null });
    expect(failed).toContain("reload to try again");
    expect(failed).not.toContain("custody admin role");
  });

  it.each([
    ["deactivated", "Deactivated"],
    ["retired", "Retired"],
    ["failed_validation", "Validation failed"],
  ] as const)("shows the credential's %s state without offering mutations", (status, label) => {
    const html = render({
      lifecycle: makeLifecycle({
        providerCredential: makeCredential({ status }),
        impact: { connections: [], projects: [] },
      }),
      connection: makeConnection({ status: "deactivated" }),
    });

    expect(html).toContain(label);
    expect(html).not.toContain("Secret deleted");
    expect(html).not.toContain("Deactivate credentials");
    expect(html).not.toContain("Rotate credentials");
  });

  it("hides every mutating control from a viewer who cannot manage custody", () => {
    const html = render({ lifecycle: makeLifecycle(), canManageCustody: false });
    expect(html).not.toContain("Deactivate credentials");
    expect(buttonDisabled(html, "Rotate credentials")).toBe(true);
  });

  describe("deactivation through a deactivated connection", () => {
    function mockApi(status = 200) {
      vi.stubEnv("SDP_API_BASE_URL", "https://api.example.test");
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const api = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
        if (String(url).endsWith("/v1/projects")) {
          return Response.json({ data: { projects: [{ id: "prj_1", slug: "default-sandbox" }] } });
        }
        if (String(url).endsWith("/provider-credentials/pcred_current/deactivate")) {
          return Response.json(
            status === 200
              ? { data: { providerCredential: makeCredential({ status: "deactivated" }) } }
              : { error: { message: "Deactivation could not be confirmed." } },
            { status }
          );
        }
        throw new Error(`Unexpected API request: ${url}`);
      });
      vi.stubGlobal("fetch", api);
      return api;
    }

    function mount(
      lifecycle = makeLifecycle({ impact: { connections: [], projects: [] } }),
      canManageCustody = true
    ) {
      return renderDOM(
        <I18nProvider locale="en" messages={getMessages("en")}>
          <ConnectionCredentialsSection
            lifecycle={lifecycle}
            connection={makeConnection({ status: "deactivated" })}
            provider="privy"
            canManageCustody={canManageCustody}
          />
        </I18nProvider>
      );
    }

    async function openDialog() {
      await userEvent.click(screen.getByRole("button", { name: "Deactivate credentials" }));
      return screen.findByRole("dialog", {
        name: "Deactivate “Privy production app” credentials?",
      });
    }

    it.each(["active", "pending"] as const)(
      "deactivates an unused %s credential without claiming deletion",
      async (status) => {
        const api = mockApi();
        const success = vi.spyOn(toast, "success").mockImplementation(() => "test-toast");
        mount(
          makeLifecycle({
            providerCredential: makeCredential({ status }),
            impact: { connections: [], projects: [] },
          })
        );
        const dialog = await openDialog();
        expect(within(dialog).getByText(/does not revoke the key at Privy/)).toBeTruthy();
        await userEvent.click(
          within(dialog).getByRole("button", { name: "Deactivate credentials" })
        );

        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(api).toHaveBeenCalledWith(
          "https://api.example.test/internal/dashboard/custody/provider-credentials/pcred_current/deactivate",
          expect.objectContaining({ method: "POST" })
        );
        expect(success).toHaveBeenCalledWith("Credentials deactivated", {
          description: "These credentials can no longer be used for signing through SDP.",
        });
        expect(refresh).toHaveBeenCalled();
      }
    );

    it("keeps a shared credential active and explains why deactivation is blocked", async () => {
      const api = mockApi();
      mount(
        makeLifecycle({
          impact: {
            projects: [{ id: "prj_other", name: "Treasury" }],
            connections: [{ id: "cconn_other", projectId: "prj_other", status: "active" }],
          },
        })
      );
      expect(screen.getByText("Active")).toBeTruthy();
      expect(screen.getByText("1 other connections across 1 projects")).toBeTruthy();
      expect(screen.queryByText("No connections use these credentials.")).toBeNull();

      const dialog = await openDialog();
      expect(
        within(dialog).getByText(/1 connections reference these credentials, in Treasury/)
      ).toBeTruthy();
      const confirm = within(dialog).getByRole("button", { name: "Deactivate credentials" });
      expect(confirm).toHaveProperty("disabled", true);
      await userEvent.click(confirm);
      expect(api).not.toHaveBeenCalled();
    });

    it.each([
      [403, "error", "Credentials not deactivated"],
      [409, "warning", "This connection changed while you were working."],
      [503, "warning", "Result unknown"],
    ] as const)(
      "keeps the dialog open on HTTP %s without claiming success",
      async (status, notification, title) => {
        mockApi(status);
        const success = vi.spyOn(toast, "success").mockImplementation(() => "test-toast");
        const notice = vi.spyOn(toast, notification).mockImplementation(() => "test-toast");
        mount();
        const dialog = await openDialog();
        await userEvent.click(
          within(dialog).getByRole("button", { name: "Deactivate credentials" })
        );

        await waitFor(() => expect(refresh).toHaveBeenCalled());
        expect(screen.getByRole("dialog")).toBeTruthy();
        expect(success).not.toHaveBeenCalled();
        expect(notice).toHaveBeenCalledWith(title, {
          description: "Deactivation could not be confirmed.",
        });
      }
    );

    it("does not offer unused-credential deactivation without custody permissions", () => {
      mount(makeLifecycle({ impact: { connections: [], projects: [] } }), false);
      expect(screen.queryByRole("button", { name: "Deactivate credentials" })).toBeNull();
    });
  });
});
