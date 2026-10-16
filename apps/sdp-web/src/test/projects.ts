import type { Project } from "@sdp/types";

const TEST_ORGANIZATION_ID = "org_test";

/** Builds a synthetic Project; the fields not under test stay fixed. */
function testProject(
  project: Pick<Project, "id" | "organizationId" | "name" | "slug" | "environment">
): Project {
  return {
    ...project,
    description: null,
    settings: null,
    status: "active",
    createdBy: "user_test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** The test Organization's default Sandbox Project. */
export const SANDBOX_PROJECT = testProject({
  id: "prj_test_sandbox",
  organizationId: TEST_ORGANIZATION_ID,
  name: "Sandbox",
  slug: "default-sandbox",
  environment: "sandbox",
});

/** The test Organization's default Production Project. */
export const PRODUCTION_PROJECT = testProject({
  id: "prj_test_production",
  organizationId: TEST_ORGANIZATION_ID,
  name: "Production",
  slug: "default-production",
  environment: "production",
});

/** A Project of another Organization, which the test user cannot list. */
export const OTHER_ORGANIZATION_PROJECT = testProject({
  id: "prj_test_other_org",
  organizationId: "org_test_other",
  name: "Sandbox",
  slug: "default-sandbox",
  environment: "sandbox",
});
