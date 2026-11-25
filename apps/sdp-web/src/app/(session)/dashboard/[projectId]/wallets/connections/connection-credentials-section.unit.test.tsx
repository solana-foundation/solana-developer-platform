// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

import { ConnectionCredentialsSection } from "./connection-credentials-section";
import type {
  CustodyCredentialLifecycle,
  CustodyInstallationConnection,
  LifecycleCredential,
} from "./connection-detail.data";
import {
  type RotationState,
  resolveCredentialActions,
  rotatableLifecycle,
} from "./credential-actions";

const HOUR_MS = 60 * 60 * 1000;
const IDLE: RotationState = { lifecycle: null, open: false };

function makeCredential(overrides: Partial<LifecycleCredential>): LifecycleCredential {
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
  overrides: Partial<CustodyInstallationConnection>
): CustodyInstallationConnection {
  return {
    id: "cconn_1",
    provider: "privy",
    label: "Production signing",
    status: "active",
    completion: null,
    canComplete: false,
    canReplaceCredentials: false,
    canCancel: false,
    ...overrides,
  };
}

function makeLifecycle(overrides: Partial<CustodyCredentialLifecycle>): CustodyCredentialLifecycle {
  return {
    providerCredential: makeCredential({}),
    rotationCandidate: null,
    impact: {
      projects: [{ id: "prj_1", name: "Acme Payments" }],
      connections: [{ id: "cconn_1", projectId: "prj_1", status: "active" }],
    },
    rollback: null,
    ...overrides,
  };
}

const UNUSED = { connections: [], projects: [] };

function restorable(hoursLeft: number): CustodyCredentialLifecycle["rollback"] {
  return {
    providerCredential: makeCredential({ id: "pcred_previous", status: "retired" }),
    expiresAt: new Date(Date.now() + hoursLeft * HOUR_MS).toISOString(),
  };
}

function renderSection({
  lifecycle,
  connection,
  canManageCustody,
  rotation,
}: {
  lifecycle: CustodyCredentialLifecycle | "restricted" | null;
  connection: CustodyInstallationConnection;
  canManageCustody: boolean;
  rotation: RotationState;
}) {
  render(
    <ConnectionCredentialsSection
      lifecycle={lifecycle}
      connection={connection}
      provider="privy"
      canManageCustody={canManageCustody}
      rotation={rotation}
      onRotationChange={vi.fn()}
    />,
    { wrapper: EnglishI18n }
  );
  return document.body.textContent;
}

const renderManaged = (lifecycle: CustodyCredentialLifecycle | "restricted" | null) =>
  renderSection({
    lifecycle,
    connection: makeConnection({}),
    canManageCustody: true,
    rotation: IDLE,
  });

function buttonDisabled(name: string): boolean {
  return screen.getByRole("button", { name }).hasAttribute("disabled");
}

afterEach(() => {
  cleanup();
  resetDashboardNavigation();
});

describe("credential actions", () => {
  it("starts a rotation from a stored credential this connection signs with", () => {
    const lifecycle = makeLifecycle({});
    expect(rotatableLifecycle(lifecycle, true, IDLE)).toBe(lifecycle);
  });

  it("starts no second rotation while the page holds one", () => {
    const lifecycle = makeLifecycle({});
    expect(rotatableLifecycle(lifecycle, true, { lifecycle, open: false })).toBeNull();
  });

  it.each([
    ["the viewer cannot manage custody", makeLifecycle({}), false],
    [
      "the deployment supplies the credential",
      makeLifecycle({ providerCredential: makeCredential({ source: "runtime" }) }),
      true,
    ],
    [
      "a candidate is waiting",
      makeLifecycle({ rotationCandidate: makeCredential({ id: "pcred_candidate" }) }),
      true,
    ],
    ["no connection uses the credential", makeLifecycle({ impact: UNUSED }), true],
    ["the read was restricted", "restricted", true],
    ["the read failed", null, true],
  ] as const)("starts no rotation when %s", (_case, lifecycle, canManageCustody) => {
    expect(rotatableLifecycle(lifecycle, canManageCustody, IDLE)).toBeNull();
  });

  it.each([
    ["active", "stored", true, true],
    ["pending", "stored", true, true],
    ["retired", "stored", true, false],
    ["deactivated", "stored", true, false],
    ["failed_validation", "stored", true, false],
    ["active", "runtime", true, false],
    ["active", "stored", false, false],
  ] as const)(
    "lets a %s %s credential be deactivated by a manager=%s: %s",
    (status, source, canManageCustody, canDeactivate) => {
      const lifecycle = makeLifecycle({ providerCredential: makeCredential({ status, source }) });
      expect(resolveCredentialActions(lifecycle, canManageCustody).canDeactivate).toBe(
        canDeactivate
      );
    }
  );
});

describe("credentials section", () => {
  it("shows the masked App ID and when the stored secret went into use", () => {
    const html = renderManaged(makeLifecycle({}));

    expect(html).toContain("····9f2a");
    expect(html).toContain("In use since Sep 09, 2026");
    expect(html).not.toContain("Not tracked by SDP");
  });

  it("says where deployment-supplied credentials are managed and offers no rollback", () => {
    const html = renderManaged(
      makeLifecycle({
        providerCredential: makeCredential({ source: "runtime" }),
        rollback: restorable(19.5),
      })
    );

    expect(html).toContain("Deployment configuration");
    expect(html).toContain("take effect on restart");
    expect(html).toContain("Not tracked by SDP");
    expect(html).not.toContain("In use since");
    expect(screen.queryByRole("button", { name: "Roll back secret" })).toBeNull();
  });

  it("offers the previous secret back while it is restorable", () => {
    const html = renderManaged(makeLifecycle({ rollback: restorable(19.5) }));

    expect(html).toContain("Restorable for 19 h, until ");
    expect(buttonDisabled("Roll back secret")).toBe(false);
  });

  it("keeps rollback disabled behind a waiting rotation and says why", () => {
    const html = renderManaged(
      makeLifecycle({
        rotationCandidate: makeCredential({ id: "pcred_candidate", status: "pending" }),
        rollback: restorable(19.5),
      })
    );

    expect(html).toContain("A rotation is waiting to finish.");
    expect(html).toContain("still in use");
    expect(buttonDisabled("Cancel rotation")).toBe(false);
    expect(buttonDisabled("Roll back secret")).toBe(true);
    expect(html).toContain("Cancel the waiting rotation before rolling back.");
  });

  it("offers no rollback to a viewer who cannot manage custody", () => {
    const html = renderSection({
      lifecycle: makeLifecycle({ rollback: restorable(19.5) }),
      connection: makeConnection({}),
      canManageCustody: false,
      rotation: IDLE,
    });

    expect(html).toContain("Restorable for 19 h");
    expect(screen.queryByRole("button", { name: "Roll back secret" })).toBeNull();
  });

  it.each([
    ["pending", false],
    ["creating", true],
  ] as const)(
    "handles a %s replacement after credential deactivation without offering retry",
    (status, cancellationDisabled) => {
      const html = renderSection({
        lifecycle: makeLifecycle({
          providerCredential: makeCredential({ status: "deactivated" }),
          rotationCandidate: makeCredential({ id: "pcred_candidate", status }),
          impact: UNUSED,
        }),
        connection: makeConnection({ status: "deactivated" }),
        canManageCustody: true,
        rotation: IDLE,
      });

      expect(html).not.toContain("The current credentials are still in use.");
      expect(buttonDisabled("Check again")).toBe(true);
      expect(buttonDisabled("Cancel rotation")).toBe(cancellationDisabled);
    }
  );

  it("says when no connection uses the credential any more", () => {
    expect(renderManaged(makeLifecycle({ impact: UNUSED }))).toContain(
      "No connections use these credentials."
    );
  });

  it("counts the other connections that share the credential", () => {
    const html = renderManaged(
      makeLifecycle({
        impact: {
          projects: [
            { id: "prj_1", name: "Acme Payments" },
            { id: "prj_other", name: "Treasury" },
          ],
          connections: [
            { id: "cconn_1", projectId: "prj_1", status: "active" },
            { id: "cconn_other", projectId: "prj_other", status: "active" },
          ],
        },
      })
    );

    expect(html).toContain("1 other connections across 1 projects");
  });

  it("distinguishes a forbidden read from a failed one", () => {
    expect(renderManaged("restricted")).toContain("custody admin role");
    cleanup();

    const failed = renderManaged(null);
    expect(failed).toContain("reload to try again");
    expect(failed).not.toContain("custody admin role");
  });

  it.each([
    ["deactivated", "Deactivated"],
    ["retired", "Retired"],
    ["failed_validation", "Validation failed"],
  ] as const)("names the credential's %s state", (status, label) => {
    renderSection({
      lifecycle: makeLifecycle({ providerCredential: makeCredential({ status }), impact: UNUSED }),
      connection: makeConnection({ status: "deactivated" }),
      canManageCustody: true,
      rotation: IDLE,
    });

    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("names no state for an active credential", () => {
    renderManaged(makeLifecycle({}));
    expect(screen.queryByText("Status")).toBeNull();
  });

  it.each([
    ["an available", makeLifecycle({})],
    ["a failed", null],
  ] as const)("offers to resume a dismissed rotation over %s read", (_case, lifecycle) => {
    renderSection({
      lifecycle,
      connection: makeConnection({}),
      canManageCustody: true,
      rotation: { lifecycle: makeLifecycle({}), open: false },
    });

    expect(screen.getByRole("button", { name: "Resume rotation" })).toBeTruthy();
  });
});
