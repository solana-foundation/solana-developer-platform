/**
 * Organization test fixtures
 */

export const TEST_ORG = {
  id: "org_test123456789",
  name: "Test Organization",
  slug: "test-org",
  tier: "individual" as const,
  status: "active" as const,
  settings: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

export const TEST_USER = {
  id: "usr_test123456789",
  email: "test@example.com",
  emailVerified: false,
  status: "active" as const,
};

export const TEST_MEMBER = {
  id: "mem_test123456789",
  organizationId: TEST_ORG.id,
  userId: TEST_USER.id,
  role: "admin" as const,
  status: "active" as const,
};
