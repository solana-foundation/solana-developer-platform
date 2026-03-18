import { createClerkClient } from "@clerk/backend";
import { getE2EEnv } from "../env";

export type ClerkTestIdentity = {
  email: string;
  organizationId: string;
  userId: string;
};

async function resolveOrganizationId(
  client: ReturnType<typeof createClerkClient>,
  env: ReturnType<typeof getE2EEnv>
): Promise<string> {
  if (env.clerkOrgId) {
    return env.clerkOrgId;
  }

  const organizations = await client.organizations.getOrganizationList({
    query: env.clerkOrgName,
    limit: 10,
  });

  const organization = organizations.data.find(
    (entry) => entry.name === env.clerkOrgName || entry.slug === env.clerkOrgName
  );

  if (!organization) {
    throw new Error(`Unable to resolve Clerk organization '${env.clerkOrgName}' for Playwright`);
  }

  return organization.id;
}

async function resolveUserEmail(
  client: ReturnType<typeof createClerkClient>,
  userId: string
): Promise<string | null> {
  const user = await client.users.getUser(userId);
  const primaryEmail =
    user.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId)?.emailAddress ??
    user.emailAddresses[0]?.emailAddress;

  return primaryEmail ?? null;
}

async function resolveExistingAdminIdentity(
  client: ReturnType<typeof createClerkClient>,
  organizationId: string
): Promise<ClerkTestIdentity> {
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId,
    role: ["org:admin"],
    limit: 10,
  });

  for (const membership of memberships.data) {
    const userId = membership.publicUserData?.userId;
    if (!userId) {
      continue;
    }

    const email = await resolveUserEmail(client, userId);
    if (!email) {
      continue;
    }

    return {
      email,
      organizationId,
      userId,
    };
  }

  throw new Error(`Unable to resolve an admin Clerk identity for organization '${organizationId}'`);
}

export async function ensureClerkAdminUser(): Promise<ClerkTestIdentity> {
  const env = getE2EEnv();
  const client = createClerkClient({ secretKey: env.clerkSecretKey });
  const organizationId = await resolveOrganizationId(client, env);

  const users = await client.users.getUserList({
    emailAddress: [env.clerkTestEmail],
    limit: 1,
  });

  const existingUser = users.data[0];
  const user =
    existingUser ??
    (await client.users.createUser({
      emailAddress: [env.clerkTestEmail],
      firstName: "SDP",
      lastName: "E2E Admin",
      skipLegalChecks: true,
      skipPasswordRequirement: true,
    }));

  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId,
    userId: [user.id],
    limit: 1,
  });

  const membership = memberships.data[0];

  try {
    if (!membership) {
      await client.organizations.createOrganizationMembership({
        organizationId,
        userId: user.id,
        role: "org:admin",
      });
    } else if (membership.role !== "org:admin") {
      await client.organizations.updateOrganizationMembership({
        organizationId,
        userId: user.id,
        role: "org:admin",
      });
    }
  } catch {
    return resolveExistingAdminIdentity(client, organizationId);
  }

  return {
    email: env.clerkTestEmail,
    organizationId,
    userId: user.id,
  };
}
