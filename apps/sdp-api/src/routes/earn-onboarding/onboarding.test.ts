import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { TEST_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { wisdomTreeOnboardingProvider } from "./handlers";

const bindings = {
  ...env,
  EARN_ENABLED: "true",
  MARKETS_ENABLED: "true",
  EARN_ONBOARDING_ENCRYPTION_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
};
const moderatorGuid = "a3c9d5b7-8a4d-4e35-9c1e-417cba654e2c";
const childGuid = "8b6f0d3e-2c71-4f5a-a1d9-3e4c7b2f9a10";
const base = "/v1/earn/onboarding/wisdomtree";
const application = {
  application: {
    entity_type: "organization",
    status: "draft",
    org_details: { name: "Example", tax_id: "DO-NOT-PERSIST" },
  },
};
const db = getDb(env);
function post(path: string, body: object, key: string) {
  return app.request(
    `${base}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    },
    bindings
  );
}
beforeEach(async () => {
  await seedTestDatabase(env);
  await db
    .prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Test', 'onboarding-http', 'individual', 'active')"
    )
    .bind(TEST_ORG.id)
    .run();
  await db
    .prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')")
    .bind(TEST_USER.id, TEST_USER.email)
    .run();
  await seedDefaultProjects(db, {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: "prj_onboarding_http", production: "prj_onboarding_http_prod" },
  });
  await seedProjectApiKey(db, env, {
    key: TEST_API_KEY,
    organizationId: TEST_ORG.id,
    projectId: "prj_onboarding_http",
    createdBy: TEST_USER.id,
    grants: ["earn.read", "earn.execute"],
  });
  await db
    .prepare(
      "INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name, status, provider_data) VALUES ('cp_http', ?, 'prj_onboarding_http', 'business', 'Example', 'active', '{}'::jsonb)"
    )
    .bind(TEST_ORG.id)
    .run();
  vi.spyOn(wisdomTreeOnboardingProvider, "getModerator").mockResolvedValue({
    guid: moderatorGuid,
    client_organizations: [],
  });
  vi.spyOn(wisdomTreeOnboardingProvider, "getBusinessForm").mockResolvedValue({
    can_create: true,
    submission_template: {},
    sections: [],
  });
  vi.spyOn(wisdomTreeOnboardingProvider, "saveBusiness").mockResolvedValue({
    organization_guid: childGuid,
    echoed_secret: "DO-NOT-PERSIST",
  });
});
afterEach(() => vi.restoreAllMocks());

describe("Earn onboarding HTTP boundary", () => {
  it("requires a credential and idempotency key before provider side effects", async () => {
    expect((await app.request(`${base}/forms/business`, {}, bindings)).status).toBe(401);
    const response = await app.request(
      `${base}/cp_http`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(application),
      },
      bindings
    );
    expect(response.status, await response.clone().text()).toBe(400);
    expect(wisdomTreeOnboardingProvider.saveBusiness).not.toHaveBeenCalled();
  });
  it("replays a safe response and never stores the applicant or echoed provider data", async () => {
    const first = await post("cp_http", application, "create-http");
    expect(first.status, await first.clone().text()).toBe(200);
    const replay = await post("cp_http", application, "create-http");
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await replay.text()).not.toMatch(/DO-NOT-PERSIST|tax_id/);
    expect(wisdomTreeOnboardingProvider.saveBusiness).toHaveBeenCalledTimes(1);
    const rows = await db.prepare("SELECT * FROM idempotency_keys").all();
    expect(JSON.stringify(rows)).not.toMatch(/DO-NOT-PERSIST|tax_id/);
  });
  it("checks the parent before even an idempotent replay", async () => {
    expect((await post("cp_http", application, "owned-replay")).status).toBe(200);
    await expect(
      db
        .prepare(
          "UPDATE counterparties SET project_id = 'prj_onboarding_http_prod' WHERE id = 'cp_http'"
        )
        .run()
    ).rejects.toThrow();
    expect((await post("cp_missing", application, "owned-replay")).status).toBe(404);
    expect(wisdomTreeOnboardingProvider.saveBusiness).toHaveBeenCalledTimes(1);
  });
  it("keeps the 1 MiB body limit on every ordinary API route", async () => {
    const res = await app.request(
      `${base}/cp_http`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "x".repeat(1024 * 1024) }),
      },
      bindings
    );
    expect(res.status).toBe(413);
  });
  it("accepts a document above 1 MiB only on the document route and returns a scoped ID", async () => {
    vi.spyOn(wisdomTreeOnboardingProvider, "uploadDocument").mockResolvedValue({
      blob_path: "private/blob.pdf",
      original_filename: "sensitive.pdf",
    });
    const res = await post(
      "cp_http/documents",
      {
        documentType: "formation_document",
        filename: "sensitive.pdf",
        contentType: "application/pdf",
        contentBase64: Buffer.alloc(800_000).toString("base64"),
      },
      "upload-http"
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.text()).toMatch(/earn_document_/);
    const rows = await db.prepare("SELECT * FROM earn_onboarding_documents").all();
    expect(JSON.stringify(rows)).not.toMatch(/private\/blob|sensitive.pdf/);
  });
});
