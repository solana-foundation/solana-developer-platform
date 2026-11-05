import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_HEADER_NAME } from "@/lib/project-cookie";
import { SANDBOX_PROJECT } from "@/test/projects";
import { resetRequestProject, setApiRequest } from "@/test/request-project";

const clerk = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@clerk/nextjs/server", () => ({ auth: clerk.auth }));

import { GET as balance } from "./balance/route";
import { GET as channels } from "./channels/route";
import { GET as deposit } from "./deposits/[depositId]/route";
import { GET as eventReferences } from "./events/references/route";
import { GET as events } from "./events/route";
import { GET as instance } from "./instance/route";
import { GET as principals } from "./principals/route";
import { GET as tokens } from "./tokens/route";
import { GET as wallets } from "./wallets/route";
import { GET as withdrawal } from "./withdrawals/[withdrawalId]/route";

const REFUSAL = {
  error: { code: "FORBIDDEN", message: "Private Channels is not enabled for this project" },
};

beforeEach(() => {
  vi.stubEnv("SDP_API_BASE_URL", "https://api.example.test");
  resetRequestProject();
  setApiRequest(SANDBOX_PROJECT.id);
  clerk.auth.mockResolvedValue({
    userId: "user_test",
    orgId: "org_test",
    getToken: vi.fn().mockResolvedValue("token_test"),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clerk.auth.mockReset();
});

describe("Private Channels dashboard reads", () => {
  it.each<[string, (request: Request) => Promise<Response>, string]>([
    ["/instance", instance, "/v1/private-channels/instance"],
    ["/channels", channels, "/v1/private-channels/channels"],
    ["/tokens", tokens, "/v1/private-channels/tokens"],
    ["/principals", principals, "/v1/private-channels/principals"],
    ["/wallets", wallets, "/v1/private-channels/wallets"],
    ["/balance?owner=Owner1111", balance, "/v1/private-channels/balance?owner=Owner1111"],
    [
      "/events?cursor=cur_test&limit=50",
      events,
      "/v1/private-channels/events?cursor=cur_test&limit=50",
    ],
    ["/events/references", eventReferences, "/v1/private-channels/events/references"],
    [
      "/deposits/pcd_test%2F1",
      (request) => deposit(request, { params: Promise.resolve({ depositId: "pcd_test/1" }) }),
      "/v1/private-channels/deposits/pcd_test%2F1",
    ],
    [
      "/withdrawals/pcw_test%2F1",
      (request) => withdrawal(request, { params: Promise.resolve({ withdrawalId: "pcw_test/1" }) }),
      "/v1/private-channels/withdrawals/pcw_test%2F1",
    ],
  ])("GET %s reads its sdp-api path and passes a refusal through", async (path, read, apiPath) => {
    const upstream = vi.fn<typeof fetch>(async () => Response.json(REFUSAL, { status: 403 }));
    vi.stubGlobal("fetch", upstream);

    const response = await read(
      new Request(`https://dashboard.example.test/api/dashboard/private-channels${path}`, {
        headers: { [PROJECT_HEADER_NAME]: SANDBOX_PROJECT.id },
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(REFUSAL);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream).toHaveBeenCalledWith(
      `https://api.example.test${apiPath}`,
      expect.objectContaining({ method: "GET" })
    );
  });
});
