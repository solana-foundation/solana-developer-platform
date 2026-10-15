import { NETWORK_METRIC_IDS, networkSnapshotSchema } from "@sdp/types/network-metrics";
import type { ExecutionContext } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import app from "@/index";
import { resetNetworkCachesForTests } from "@/services/network/network.service";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { authenticateTestClerkUser } from "@/test/helpers/clerk";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORG = { id: "org_network_test", name: "Network Test Org", slug: "network-test-org" };
const USER = { id: "usr_network_test", email: "network-test@example.com" };
const PROJECT_ID = `prj_${ORG.id}_sandbox`;
const API_KEY = { id: "key_network_gate", raw: "sk_test_network_gate", prefix: "sk_test_net" };

const DAY = {
  "Circulating Supply": "15894704166.8",
  "Transfer Count": "14280558",
  "Non Vote Transaction Count (Success)": "118138000",
  Fees: "8010.4",
  "SOL Price": "110.5",
};
const METRICS_BODY = {
  source: "memory_cache",
  data: {
    generatedAt: "2026-10-13T13:45:57Z",
    truncated: false,
    rows: Object.entries(DAY).map(([metric, value]) => ({
      date: "2026-10-12",
      metric_name: metric,
      unit: "",
      provider_name: "Dune",
      value,
    })),
  },
};
const STATUS_BODY = {
  components: [{ id: "qxs6x3yc9cxg", name: "Mainnet Beta - Cluster", status: "operational" }],
};

const responseSchema = z.object({ data: networkSnapshotSchema });
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const realFetch = globalThis.fetch;

/** Answers data.solana.com and status.solana.com; everything else goes out as usual. */
function mockSources(metrics: () => Response = () => Response.json(METRICS_BODY)) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://data.solana.com/")) return metrics();
    if (url.startsWith("https://status.solana.com/")) return Response.json(STATUS_BODY);
    return realFetch(input, init);
  });
}

const sourceCalls = (spy: ReturnType<typeof mockSources>, host: string) =>
  spy.mock.calls.filter(([input]) =>
    (input instanceof Request ? input.url : String(input)).startsWith(`https://${host}/`)
  ).length;

async function dashboardHeaders(): Promise<Record<string, string>> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG.id, ORG.name, ORG.slug, "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER.id, USER.email),
  ]);
  await seedDefaultProjects(db, { organizationId: ORG.id, createdBy: USER.id, members: [USER.id] });
  const actor = await authenticateTestClerkUser(env, db, {
    userId: USER.id,
    email: USER.email,
    clerkUserId: "clerk_user_network_test",
    organizationId: ORG.id,
    clerkOrgId: "org_clerk_network_test",
    orgSlug: ORG.slug,
    role: "member",
  });
  return actor.headers(PROJECT_ID);
}

let originalKey: string | undefined;

beforeEach(async () => {
  await seedTestDatabase(env);
  await clearKVStores(env);
  resetNetworkCachesForTests();
  originalKey = env.DATA_API_KEY;
  env.DATA_API_KEY = "data_test_key";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  env.DATA_API_KEY = originalKey;
});

describe("GET /internal/dashboard/network", () => {
  it("serves a dashboard session the snapshot, reading each source once for many requests", async () => {
    const headers = await dashboardHeaders();
    const fetchSpy = mockSources();

    for (let request = 0; request < 3; request++) {
      const response = await app.request("/internal/dashboard/network", { headers }, env);
      expect(response.status).toBe(200);
      const { data } = responseSchema.parse(await response.json());
      expect(data.asOf).toBe("2026-10-12");
      expect(data.health?.state).toBe("operational");
      expect(Object.keys(data.metrics)).toEqual([...NETWORK_METRIC_IDS]);
    }
    expect(sourceCalls(fetchSpy, "data.solana.com")).toBe(1);
    expect(sourceCalls(fetchSpy, "status.solana.com")).toBe(1);
  });

  it("hands a refresh behind a stale copy to the request's background runner", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const headers = await dashboardHeaders();
    const fetchSpy = mockSources();
    const handedOver: Promise<unknown>[] = [];
    const executionCtx: ExecutionContext = {
      waitUntil: (promise) => {
        handedOver.push(promise.catch(() => undefined));
      },
      passThroughOnException: () => undefined,
      props: {},
    };
    const read = () => app.request("/internal/dashboard/network", { headers }, env, executionCtx);

    expect((await read()).status).toBe(200);
    expect(handedOver).toHaveLength(0);
    // Past health's two fresh minutes: the stale copy answers, and its refresh runs behind it
    // where a shutdown drains it.
    vi.setSystemTime(Date.now() + 150_000);
    expect((await read()).status).toBe(200);
    expect(handedOver).toHaveLength(1);
    await Promise.all(handedOver);
    expect(sourceCalls(fetchSpy, "status.solana.com")).toBe(2);
  });

  it("refuses a valid API key: the figures are for dashboard sessions only", async () => {
    await dashboardHeaders();
    await seedProjectApiKey(getDb(env), env, {
      key: API_KEY,
      organizationId: ORG.id,
      projectId: PROJECT_ID,
      createdBy: USER.id,
      role: "api_developer",
      permissions: ["payments:read"],
    });
    const fetchSpy = mockSources();

    const response = await app.request(
      "/internal/dashboard/network",
      { headers: { Authorization: `Bearer ${API_KEY.raw}` } },
      env
    );
    expect(response.status).toBe(401);
    expect(errorSchema.parse(await response.json()).error).toEqual({
      code: "UNAUTHORIZED",
      message: "Clerk JWT required",
    });
    expect(sourceCalls(fetchSpy, "data.solana.com")).toBe(0);
  });

  it("answers 503 when data.solana.com fails and no copy can be served", async () => {
    const headers = await dashboardHeaders();
    mockSources(() => new Response("upstream down", { status: 502 }));

    const response = await app.request("/internal/dashboard/network", { headers }, env);
    expect(response.status).toBe(503);
    expect(errorSchema.parse(await response.json()).error.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("answers 503 when no key is configured, without calling out", async () => {
    const headers = await dashboardHeaders();
    env.DATA_API_KEY = undefined;
    const fetchSpy = mockSources();

    const response = await app.request("/internal/dashboard/network", { headers }, env);
    expect(response.status).toBe(503);
    expect(errorSchema.parse(await response.json()).error.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(sourceCalls(fetchSpy, "data.solana.com")).toBe(0);
  });
});
