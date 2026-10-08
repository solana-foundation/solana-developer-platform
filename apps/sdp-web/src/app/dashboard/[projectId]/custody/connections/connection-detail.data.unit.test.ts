import { describe, expect, it, vi } from "vitest";
import {
  type CustodyCredentialLifecycle,
  canRollBack,
  fetchConnectionListItem,
  isCredentialManagedHere,
  type LifecycleCredential,
  ROLLBACK_WINDOW_MS,
  resolveRetiredAt,
  rollbackHoursRemaining,
} from "./connection-detail.data";

const NOW = Date.parse("2026-09-09T14:20:00.000Z");

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
    rollback: {
      providerCredential: makeCredential({ id: "pcred_previous", status: "retired" }),
      expiresAt: new Date(NOW + ROLLBACK_WINDOW_MS).toISOString(),
    },
    ...overrides,
  };
}

describe("credential source", () => {
  it("only treats SDP-stored credentials as manageable here", () => {
    expect(isCredentialManagedHere(makeCredential({ source: "stored" }))).toBe(true);
    // The deployment supplies these through the environment; there is no
    // stored secret for SDP to replace, and the API refuses either way.
    expect(isCredentialManagedHere(makeCredential({ source: "runtime" }))).toBe(false);
  });
});

describe("rollback window", () => {
  it("derives the retirement moment from the deadline the API publishes", () => {
    const expiresAt = new Date(NOW + ROLLBACK_WINDOW_MS).toISOString();
    expect(resolveRetiredAt(expiresAt)?.toISOString()).toBe(new Date(NOW).toISOString());
  });

  it("ignores an unparseable deadline rather than inventing a date", () => {
    expect(resolveRetiredAt("not-a-date")).toBeNull();
  });

  it("counts whole hours left and never goes negative", () => {
    const expiresAt = new Date(NOW + 19 * 60 * 60 * 1000).toISOString();
    expect(rollbackHoursRemaining(expiresAt, NOW)).toBe(19);

    const expired = new Date(NOW - 60 * 60 * 1000).toISOString();
    expect(rollbackHoursRemaining(expired, NOW)).toBe(0);
  });
});

describe("rollback availability", () => {
  it("is offered while the API still holds a target inside the window", () => {
    expect(canRollBack(makeLifecycle(), NOW)).toEqual({ available: true });
  });

  it("is withheld when the API offers no target at all", () => {
    // An expired window has no distinct error code, so a null target is the
    // only honest way to pre-empt the 409.
    expect(canRollBack(makeLifecycle({ rollback: null }), NOW)).toEqual({
      available: false,
      reason: "no_target",
    });
  });

  it("is withheld while a rotation candidate is still waiting", () => {
    const lifecycle = makeLifecycle({
      rotationCandidate: makeCredential({ id: "pcred_candidate", status: "pending" }),
    });
    expect(canRollBack(lifecycle, NOW)).toEqual({
      available: false,
      reason: "rotation_pending",
    });
  });

  it("is withheld once the published deadline has passed", () => {
    const lifecycle = makeLifecycle({
      rollback: {
        providerCredential: makeCredential({ id: "pcred_previous", status: "retired" }),
        expiresAt: new Date(NOW - 1000).toISOString(),
      },
    });
    expect(canRollBack(lifecycle, NOW)).toEqual({ available: false, reason: "expired" });
  });
});

describe("fetchConnectionListItem", () => {
  function listRow(id: string) {
    return {
      id,
      provider: "privy" as const,
      label: "Treasury",
      status: "active" as const,
      isDefault: true,
      isRuntimeExecutionAllowed: true,
      defaultCustodyWalletId: null,
      createdAt: "2026-08-10T09:00:00.000Z",
      activatedAt: "2026-08-10T09:05:00.000Z",
      lastCheck: null,
      pendingWalletLabel: null,
    };
  }

  function page(connections: ReturnType<typeof listRow>[], offset: number, total: number) {
    return new Response(
      JSON.stringify({ data: { connections, pagination: { limit: 50, offset, total } } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // Four pages spent on other providers is how this walk used to end one row
  // short of the connection it was sent to find.
  it("narrows the walk to the provider the caller knows", async () => {
    const request = vi.fn(async () => page([listRow("conn-1")], 0, 1));

    await expect(fetchConnectionListItem(request, "conn-1", "privy")).resolves.toMatchObject({
      id: "conn-1",
    });
    expect(request).toHaveBeenCalledWith(
      "/internal/dashboard/custody/connections?limit=50&offset=0&provider=privy"
    );
  });

  it("walks the project unnarrowed when the provider is unknown", async () => {
    const request = vi.fn(async () => page([listRow("conn-1")], 0, 1));

    await fetchConnectionListItem(request, "conn-1");

    expect(request).toHaveBeenCalledWith(
      "/internal/dashboard/custody/connections?limit=50&offset=0"
    );
  });

  it("gives up rather than paging forever, and says nothing instead", async () => {
    const request = vi.fn(async (path: string) =>
      page(
        [listRow(`conn-${new URL(path, "https://sdp.test").searchParams.get("offset")}`)],
        0,
        1000
      )
    );

    await expect(fetchConnectionListItem(request, "conn-missing", "privy")).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(4);
  });
});
