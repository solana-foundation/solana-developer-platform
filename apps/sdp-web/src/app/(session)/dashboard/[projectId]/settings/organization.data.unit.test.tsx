// @vitest-environment jsdom
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@/lib/idempotency";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider, EnglishDashboardReads } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { useCurrentOrganization } from "./organization.data";
import { OrganizationAccessSection } from "./organization-access-section";
import { OrganizationAlertEmailsSection } from "./organization-alert-emails-section";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

function organization(settings: JsonValue): Response {
  return dashboardDataResponse(200, { id: "org_test_1", name: "Acme", settings });
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useCurrentOrganization", () => {
  it.each<[JsonValue, { allowedIps: string[]; alertEmailsEnabled: boolean }]>([
    [null, { allowedIps: [], alertEmailsEnabled: true }],
    [{}, { allowedIps: [], alertEmailsEnabled: true }],
    [{ alertEmails: true }, { allowedIps: [], alertEmailsEnabled: true }],
    [
      { allowedIpAddresses: ["203.0.113.0/24"], alertEmails: false },
      { allowedIps: ["203.0.113.0/24"], alertEmailsEnabled: false },
    ],
  ])("reads settings %j as %j: unrestricted and alerting unless set", async (settings, read) => {
    const fetchMock = stubDashboardFetch(() => organization(settings));

    const { result } = renderHook(useCurrentOrganization, { wrapper: DashboardReadsProvider });

    await waitFor(() => expect(result.current.data).toMatchObject({ id: "org_test_1", ...read }));
    expect(sentDashboardReads(fetchMock)).toEqual([
      { path: "/api/dashboard/organizations/current", projectId: SANDBOX_PROJECT.id, demo: null },
    ]);
  });
});

describe("organization settings sections", () => {
  it.each<[string, ComponentType, () => Response, string, string]>([
    [
      "the allowlist",
      OrganizationAccessSection,
      () => dashboardErrorResponse(503, "upstream unavailable"),
      "Could not load the IP allowlist: upstream unavailable",
      "Allowed IP addresses",
    ],
    [
      "the allowlist",
      OrganizationAccessSection,
      () => organization({ allowedIpAddresses: "203.0.113.0/24" }),
      "Could not load the IP allowlist: the server did not answer as expected",
      "Allowed IP addresses",
    ],
    [
      "alert emails",
      OrganizationAlertEmailsSection,
      () => dashboardErrorResponse(503, "upstream unavailable"),
      "Could not load the email alert setting: upstream unavailable",
      "Send alert emails",
    ],
    [
      "alert emails",
      OrganizationAlertEmailsSection,
      () => organization({ alertEmails: "no" }),
      "Could not load the email alert setting: the server did not answer as expected",
      "Send alert emails",
    ],
  ])(
    "shows no control for %s until a readable answer (%#), then on retry",
    async (_section, Section, failure, shown, control) => {
      const fetchMock = stubDashboardFetch(() =>
        fetchMock.mock.calls.length === 1 ? failure() : organization({})
      );
      const user = userEvent.setup();
      render(<Section />, { wrapper: EnglishDashboardReads });

      expect((await screen.findByRole("alert")).textContent).toContain(shown);
      expect(screen.queryByLabelText(control)).toBeNull();
      await user.click(screen.getByRole("button", { name: "Try again" }));

      expect(await screen.findByLabelText(control)).toBeTruthy();
    }
  );
});
