import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { getDb } from "@/db/client";
import {
  dailyGrowthMessage,
  postDailyGrowthSummary,
  previousUtcDay,
  readDailyGrowth,
} from "@/services/daily-growth-summary";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secret";
const NOW = new Date("2026-11-17T15:00:00Z");
const DAY = "2026-11-16";

async function seedUser(id: string, email: string, createdAt: string, status = "active") {
  await getDb(env)
    .prepare("INSERT INTO users (id, email, name, status, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, id === "usr_grow_ada" ? "Ada Lovelace" : null, status, createdAt)
    .run();
}

async function seedOrganization(id: string, name: string, createdAt: string, adminId?: string) {
  const db = getDb(env);
  await db
    .prepare(
      "INSERT INTO organizations (id, name, slug, tier, status, created_at) VALUES (?, ?, ?, 'enterprise', 'active', ?)"
    )
    .bind(id, name, id, createdAt)
    .run();
  if (adminId) {
    await db
      .prepare(
        "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, 'admin', 'active')"
      )
      .bind(`mem_${id}`, id, adminId)
      .run();
  }
}

describe("daily growth summary", () => {
  let slack: MockInstance<typeof fetch>;

  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedUser("usr_grow_ada", "ada@acme.example", "2026-11-16 09:00:00");
    await seedUser("usr_grow_bob", "bob@other.example", "2026-11-16T23:59:59.000Z");
    await seedUser("usr_grow_old", "old@acme.example", "2026-11-15 23:59:59");
    await seedUser("usr_grow_today", "today@acme.example", "2026-11-17 00:00:00");
    await seedUser("usr_grow_gone", "erased@deleted.invalid", "2026-11-16 10:00:00", "deleted");
    await seedOrganization(
      "org_grow_acme",
      "Acme <!channel>",
      "2026-11-16 09:01:00",
      "usr_grow_ada"
    );
    await seedOrganization("org_grow_old", "Old Co", "2026-11-15 12:00:00");
    env.SDP_REQUESTS_SLACK_WEBHOOK_URL = WEBHOOK;
    const realFetch = globalThis.fetch;
    slack = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) =>
        String(input) === WEBHOOK ? new Response("ok") : realFetch(input, init)
      );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    env.SDP_REQUESTS_SLACK_WEBHOOK_URL = undefined;
    await clearKVStores(env);
  });

  function posts(): string[] {
    return slack.mock.calls
      .filter(([url]) => String(url) === WEBHOOK)
      .map(([, init]) => String(init?.body));
  }

  it("summarizes the UTC day before now", () => {
    expect(previousUtcDay(NOW)).toBe(DAY);
    expect(previousUtcDay(new Date("2026-03-01T00:30:00Z"))).toBe("2026-02-28");
  });

  it("reads the day's organizations with their admin, and its signups, leaving erased ones out", async () => {
    const growth = await readDailyGrowth(env, DAY);
    expect(growth.organizations).toEqual([
      { id: "org_grow_acme", name: "Acme <!channel>", adminEmail: "ada@acme.example" },
    ]);
    expect(growth.signups).toEqual([
      { email: "ada@acme.example", name: "Ada Lovelace" },
      { email: "bob@other.example", name: null },
    ]);
  });

  it("escapes names and caps each list", () => {
    const message = dailyGrowthMessage({
      day: DAY,
      organizations: [{ id: "org_1", name: "Acme <!channel>", adminEmail: null }],
      signups: Array.from({ length: 30 }, (_, index) => ({
        email: `u${index}@x.example`,
        name: null,
      })),
    });
    const body = JSON.stringify(message);
    expect(body).not.toContain("<!channel>");
    expect(body).toContain("Acme &lt;!channel&gt;");
    expect(body).toContain("…and 5 more");
    expect(message.text).toBe("SDP daily: 1 new organization, 30 signups on Mon, 16 Nov 2026");
  });

  it("posts the day once, however many slots fire", async () => {
    await expect(postDailyGrowthSummary(env, NOW)).resolves.toBe(true);
    await expect(postDailyGrowthSummary(env, NOW)).resolves.toBe(false);
    const [posted, ...others] = posts();
    expect(others).toHaveLength(0);
    expect(posted).toContain("1 new organization, 2 signups");
    expect(posted).toContain("Ada Lovelace · ada@acme.example");
    expect(posted).not.toContain("old@acme.example");
  });

  it("lets a later slot retry a post that failed", async () => {
    slack.mockImplementationOnce(async () => new Response("no_service", { status: 404 }));
    await expect(postDailyGrowthSummary(env, NOW)).rejects.toThrow("status 404");
    await expect(postDailyGrowthSummary(env, NOW)).resolves.toBe(true);
    expect(posts()).toHaveLength(2);
  });

  it("posts nothing without the webhook", async () => {
    env.SDP_REQUESTS_SLACK_WEBHOOK_URL = undefined;
    await expect(postDailyGrowthSummary(env, NOW)).resolves.toBe(false);
    expect(posts()).toHaveLength(0);
  });
});
