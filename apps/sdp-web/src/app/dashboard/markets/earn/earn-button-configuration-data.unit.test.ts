import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dashboardFetch: vi.fn() }));

vi.mock("@/lib/dashboard-fetch", () => ({ dashboardFetch: mocks.dashboardFetch }));

import { saveEarnButtonConfiguration } from "./earn-button-configuration-data";

describe("saveEarnButtonConfiguration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dashboardFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        data: {
          configuration: {
            id: "earn_button_config_example",
            strategyId: "earn_strategy_example",
            style: "accent",
            accentColor: "#9945FF",
            publicToken: "PublicEarnButtonToken123",
            createdAt: "2026-08-24T00:00:00.000Z",
            updatedAt: "2026-08-24T00:00:00.000Z",
          },
        },
      },
    });
  });

  it("pins the request to the rendered project without adding scope to the API body", async () => {
    await expect(
      saveEarnButtonConfiguration({
        projectId: "project_original",
        strategyId: "earn_strategy_example",
        style: "accent",
        accentColor: "#9945FF",
      })
    ).resolves.toMatchObject({ ok: true, status: 200 });

    expect(mocks.dashboardFetch).toHaveBeenCalledWith(
      "/api/dashboard/markets/earn/button-configuration",
      {
        method: "PUT",
        headers: { "x-project-id": "project_original" },
        body: {
          strategyId: "earn_strategy_example",
          style: "accent",
          accentColor: "#9945FF",
        },
      }
    );
  });

  it("uses the client product name when a saved configuration response is invalid", async () => {
    mocks.dashboardFetch.mockResolvedValueOnce({ ok: true, status: 200, data: {} });

    await expect(
      saveEarnButtonConfiguration({
        projectId: "project_original",
        strategyId: "earn_strategy_example",
        style: "accent",
        accentColor: "#9945FF",
      })
    ).resolves.toMatchObject({
      ok: false,
      error: "Invalid Embedded Yield button configuration response",
    });
  });
});
