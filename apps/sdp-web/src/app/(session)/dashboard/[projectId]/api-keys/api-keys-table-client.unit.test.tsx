// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { membersQueryKeys } from "@/app/(session)/dashboard/[projectId]/settings/members-query-key";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { type DashboardKeyScope, dashboardRequestUrl } from "@/lib/dashboard-request-key";
import { dashboardDataResponse, readsOf, stubDashboardFetch } from "@/test/dashboard-fetch";
import { renderBesideReads } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { deactivateApiKeyInlineAction, rotateApiKeyAction } from "./actions";
import { apiKeysQueryKeys } from "./api-keys-query-key";
import { type ApiKeyRecord, ApiKeysTableClient } from "./api-keys-table-client";

const rotation = vi.hoisted(() => ({ submission: Promise.withResolvers<void>() }));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("./actions", () => ({
  rotateApiKeyAction: vi.fn(() => rotation.submission.promise),
  deactivateApiKeyInlineAction: vi.fn(),
}));

const HOUR_MS = 60 * 60 * 1000;

function key(id: string, rotationDeadline: string | null): ApiKeyRecord {
  return {
    id,
    name: id,
    keyPrefix: "sk_test_abc",
    grants: ["transfers.read"],
    environment: "sandbox",
    status: "active",
    walletScope: "all",
    walletIds: [],
    lastUsedAt: null,
    expiresAt: null,
    rotationDeadline,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

function renderTable(apiKeys: ApiKeyRecord[]) {
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ApiKeysTableClient initialApiKeys={apiKeys} canManageApiKeys={false} wallets={[]} />
    </I18nProvider>
  );
}

const SCOPE: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "live" };
const KEY_READS = [
  apiKeysQueryKeys.list(SCOPE),
  membersQueryKeys.memberApiKeys(SCOPE, { memberId: "mem_test_1" }),
];

function keyReadCounts(fetchMock: Mock<typeof fetch>): number[] {
  return KEY_READS.map((requestKey) => readsOf(fetchMock, dashboardRequestUrl(requestKey)));
}

async function openActions(user: ReturnType<typeof userEvent.setup>, item: string) {
  renderBesideReads(
    <ApiKeysTableClient initialApiKeys={[key("key_test_1", null)]} canManageApiKeys wallets={[]} />,
    KEY_READS
  );
  await user.click(screen.getByRole("button", { name: "Actions" }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ApiKeysTableClient", () => {
  // A rotated key past its deadline stays active in the row but no longer
  // authenticates, so it must not read as still rotating.
  it("labels a key rotating only before its rotation deadline", () => {
    renderTable([
      key("in-grace", new Date(Date.now() + HOUR_MS).toISOString()),
      key("past-deadline", new Date(Date.now() - HOUR_MS).toISOString()),
    ]);

    expect(screen.getAllByText("rotating")).toHaveLength(1);
  });
});

describe("ApiKeysTableClient writes", () => {
  it("re-reads the keys and members' key lists once a rotation's submission finishes", async () => {
    rotation.submission = Promise.withResolvers<void>();
    const fetchMock = stubDashboardFetch(() => dashboardDataResponse(200, {}));
    const user = userEvent.setup();

    await openActions(user, "Rotate key (24h grace)");
    await user.click(await screen.findByRole("button", { name: "Rotate key" }));

    await waitFor(() => expect(rotateApiKeyAction).toHaveBeenCalledOnce());
    expect(keyReadCounts(fetchMock)).toEqual([1, 1]);
    await act(async () => rotation.submission.resolve());
    await waitFor(() => expect(keyReadCounts(fetchMock)).toEqual([2, 2]));
  });

  it("re-reads the keys and members' key lists after a delete", async () => {
    vi.mocked(deactivateApiKeyInlineAction).mockResolvedValue({ ok: true, message: "Deleted" });
    const fetchMock = stubDashboardFetch(() => dashboardDataResponse(200, {}));
    const user = userEvent.setup();

    await openActions(user, "Delete key");
    await user.type(await screen.findByLabelText("Confirm key name"), "key_test_1");
    await user.click(screen.getByRole("button", { name: "Delete key" }));

    await waitFor(() => expect(keyReadCounts(fetchMock)).toEqual([2, 2]));
  });
});
