// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testApiKey } from "@/test/api-keys";
import { stubClerkSession } from "@/test/clerk";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import { HeaderHost } from "@/test/dashboard-page-title";
import { EnglishI18n } from "@/test/i18n";
import { SANDBOX_PROJECT } from "@/test/projects";

vi.mock("next/cache", () => import("@/test/next-cache"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

import { ApiKeyDetailView } from "./api-key-detail-view";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");

beforeEach(() => {
  stubClerkSession({ userId: null });
  resetDashboardNavigation();
  setDashboardUrl(`/dashboard/${SANDBOX_PROJECT.id}/api-keys/key_test_1`, {
    keyId: "key_test_1",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type KeyLifetime = Parameters<typeof testApiKey>[0];

const LIVE: KeyLifetime = {
  status: "active",
  expiresAt: "2027-01-01T00:00:00.000Z",
  rotationDeadline: null,
};

describe("ApiKeyDetailView controls", () => {
  it.each<[string, KeyLifetime, boolean, number[]]>([
    ["a live key to a manager", LIVE, true, [3, 1, 1]],
    [
      "a replaced key",
      { status: "active", expiresAt: null, rotationDeadline: "2026-11-07T12:00:00.000Z" },
      true,
      [3, 0, 1],
    ],
    [
      "an expired key",
      { status: "active", expiresAt: "2026-11-01T00:00:00.000Z", rotationDeadline: null },
      true,
      [0, 0, 0],
    ],
    ["a revoked key", { ...LIVE, status: "revoked" }, true, [0, 0, 0]],
    ["a live key to a viewer", LIVE, false, [0, 0, 0]],
  ])(
    "offers %s only the edit, rotate and revoke controls it may use",
    (_case, lifetime, canManageApiKeys, controls) => {
      render(
        <EnglishI18n>
          <HeaderHost>
            <ApiKeyDetailView
              apiKey={testApiKey(lifetime)}
              wallets={[]}
              offered={["transfers.read", "transfers.execute"]}
              canManageApiKeys={canManageApiKeys}
              apiBaseUrl={null}
              now={NOW}
            />
          </HeaderHost>
        </EnglishI18n>
      );

      expect(screen.getByRole("heading", { level: 1, name: "Payouts worker" })).toBeTruthy();
      expect(
        ["Edit", "Rotate key…", "Revoke key…"].map(
          (name) => screen.queryAllByRole("button", { name }).length
        )
      ).toEqual(controls);
    }
  );
});
