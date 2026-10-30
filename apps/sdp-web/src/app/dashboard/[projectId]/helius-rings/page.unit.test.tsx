import * as clerk from "@clerk/nextjs/server";
import { afterEach, expect, it, vi } from "vitest";
import * as flags from "@/flags";
import { SANDBOX_PROJECT } from "@/test/projects";
import { resetRequestProject, setPageRequest } from "@/test/request-project";
import { HeliusRingsWorkspace } from "./helius-rings-workspace";
import HeliusRingsPage from "./page";

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetRequestProject();
});

it("passes the internal Custody ID from wallet summaries to the workspace", async () => {
  vi.spyOn(clerk, "auth");
  vi.mocked(clerk.auth, { partial: true }).mockResolvedValue({
    userId: "user_test",
    orgId: "org_test",
    getToken: async () => "token_test",
  });
  vi.stubEnv("SDP_API_BASE_URL", "https://api.example.test");
  vi.spyOn(flags, "heliusRings").mockResolvedValue(true);
  setPageRequest(`/dashboard/${SANDBOX_PROJECT.id}/helius-rings`);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: {
        wallets: [
          {
            id: "cwlt_treasury",
            label: "Treasury",
            publicKey: "TreasuryOwner111",
          },
        ],
      },
    })
  );

  const page = await HeliusRingsPage();

  expect(fetch).toHaveBeenCalledWith(
    "https://api.example.test/v1/wallets?view=summary",
    expect.objectContaining({ method: "GET" })
  );
  expect(page).toMatchObject({
    props: {
      children: {
        type: HeliusRingsWorkspace,
        props: {
          custodyWallets: [
            { id: "cwlt_treasury", label: "Treasury", publicKey: "TreasuryOwner111" },
          ],
        },
      },
    },
  });
});
