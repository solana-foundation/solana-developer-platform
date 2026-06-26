import { createClerkClient } from "@clerk/backend";
import type { OrganizationTier } from "@sdp/types";
import { getE2EEnv } from "../env";

export type ClerkTestIdentity = {
  email: string;
  organizationId: string;
  userId: string;
};

type ClerkOrganizationRecord = {
  private_metadata?: unknown;
};

const CLERK_TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function isRetryableClerkError(error: unknown): boolean {
  const record = asRecord(error);
  const status = record?.status ?? record?.statusCode;
  const statusNumber =
    typeof status === "number" ? status : typeof status === "string" ? Number(status) : null;
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : record?.name;
  const clerkErrors = Array.isArray(record?.errors)
    ? record.errors
        .map((entry) => asRecord(entry))
        .map((entry) => `${String(entry?.code ?? "")} ${String(entry?.message ?? "")}`)
        .join(" ")
    : "";

  return (
    (typeof statusNumber === "number" && statusNumber >= 500) ||
    name === "ClerkAPIResponseError" ||
    message.includes("Internal Server Error") ||
    message.includes("fetch failed") ||
    message.includes("timed out") ||
    clerkErrors.includes("unexpected_error")
  );
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTransientClerkRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= CLERK_TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryableClerkError(error) || attempt === CLERK_TRANSIENT_RETRY_DELAYS_MS.length) {
        throw error;
      }

      await wait(CLERK_TRANSIENT_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError;
}

async function requestClerk<T>(path: string, options: RequestInit = {}): Promise<T> {
  const env = getE2EEnv();
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.clerkSecretKey}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Clerk request failed (${response.status}) for ${path}`);
  }

  return (await response.json()) as T;
}

async function resolveOrganizationId(
  client: ReturnType<typeof createClerkClient>,
  env: ReturnType<typeof getE2EEnv>
): Promise<string> {
  if (env.clerkOrgId) {
    return env.clerkOrgId;
  }

  const organizations = await withTransientClerkRetry(() =>
    client.organizations.getOrganizationList({
      query: env.clerkOrgName,
      limit: 10,
    })
  );

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
  const user = await withTransientClerkRetry(() => client.users.getUser(userId));
  const primaryEmail =
    user.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId)?.emailAddress ??
    user.emailAddresses[0]?.emailAddress;

  return primaryEmail ?? null;
}

async function resolveExistingAdminIdentity(
  client: ReturnType<typeof createClerkClient>,
  organizationId: string
): Promise<ClerkTestIdentity> {
  const memberships = await withTransientClerkRetry(() =>
    client.organizations.getOrganizationMembershipList({
      organizationId,
      role: ["org:admin"],
      limit: 10,
    })
  );

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

  const users = await withTransientClerkRetry(() =>
    client.users.getUserList({
      emailAddress: [env.clerkTestEmail],
      limit: 1,
    })
  );

  const existingUser = users.data[0];
  const user =
    existingUser ??
    (await withTransientClerkRetry(() =>
      client.users.createUser({
        emailAddress: [env.clerkTestEmail],
        firstName: "SDP",
        lastName: "E2E Admin",
        skipLegalChecks: true,
        skipPasswordRequirement: true,
      })
    ));

  const memberships = await withTransientClerkRetry(() =>
    client.organizations.getOrganizationMembershipList({
      organizationId,
      userId: [user.id],
      limit: 1,
    })
  );

  const membership = memberships.data[0];

  try {
    if (!membership) {
      await withTransientClerkRetry(() =>
        client.organizations.createOrganizationMembership({
          organizationId,
          userId: user.id,
          role: "org:admin",
        })
      );
    } else if (membership.role !== "org:admin") {
      await withTransientClerkRetry(() =>
        client.organizations.updateOrganizationMembership({
          organizationId,
          userId: user.id,
          role: "org:admin",
        })
      );
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

export async function setClerkOrganizationTier(
  organizationId: string,
  tier: OrganizationTier
): Promise<void> {
  const organization = await requestClerk<ClerkOrganizationRecord>(
    `/organizations/${organizationId}`
  );
  const privateMetadata = asRecord(organization.private_metadata) ?? {};
  const sdpMetadata = asRecord(privateMetadata.sdp) ?? {};
  const nextPrivateMetadata = {
    ...privateMetadata,
    sdp: {
      ...sdpMetadata,
      tier,
      providerOverrides: undefined,
    },
  };

  await requestClerk(`/organizations/${organizationId}`, {
    method: "PATCH",
    body: JSON.stringify({
      private_metadata: nextPrivateMetadata,
    }),
  });
}
