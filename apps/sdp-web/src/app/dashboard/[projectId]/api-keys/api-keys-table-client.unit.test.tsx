// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { type ApiKeyRecord, ApiKeysTableClient } from "./api-keys-table-client";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

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

afterEach(cleanup);

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
