import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/app/dashboard/custody/wallet-provider-mark", () => ({
  WalletProviderMark: () => <span>Provider mark</span>,
}));

import { ConnectionCredentialsSection } from "./connection-credentials-section";
import type {
  CustodyCredentialLifecycle,
  CustodyInstallationConnection,
  LifecycleCredential,
} from "./connection-detail.data";
import { ROLLBACK_WINDOW_MS } from "./connection-detail.data";

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

  it("offers nothing on a deactivated connection and says the secret is gone", () => {
    const html = render({
      lifecycle: makeLifecycle(),
      connection: makeConnection({ status: "deactivated" }),
    });

    expect(html).toContain("No longer used by any connection. Secret deleted.");
    expect(html).not.toContain("Rotate credentials");
  });

  it("distinguishes a forbidden read from a failed one", () => {
    // Not permitted is a settled answer; a failed read is not, and inviting a
    // retry is only honest in the second case.
    expect(render({ lifecycle: "restricted" })).toContain("custody admin role");

    const failed = render({ lifecycle: null });
    expect(failed).toContain("reload to try again");
    expect(failed).not.toContain("custody admin role");
  });

  it("hides every mutating control from a viewer who cannot manage custody", () => {
    const html = render({ lifecycle: makeLifecycle(), canManageCustody: false });
    expect(html).not.toContain("Deactivate credentials");
    expect(buttonDisabled(html, "Rotate credentials")).toBe(true);
  });
});
