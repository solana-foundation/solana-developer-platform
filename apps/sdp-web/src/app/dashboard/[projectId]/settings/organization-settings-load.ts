import { createOrgSdpApiClient } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";
import { resolveOrganizationId } from "./organization-id";
import {
  organizationAlertEmailsSchema,
  organizationAllowlistSchema,
} from "./organization-settings";

export type OrganizationIpAllowlist =
  | { ok: true; organizationId: string; allowedIps: string[] }
  | { ok: false; error: string };

export type OrganizationAlertEmails =
  | { ok: true; organizationId: string; enabled: boolean }
  | { ok: false; error: string };

async function readOrganization(): Promise<{ organizationId: string; organization: unknown }> {
  const client = await createOrgSdpApiClient();
  const organizationId = await resolveOrganizationId(client);
  const organization = await client.fetch<unknown>(
    `/v1/organizations/${encodeURIComponent(organizationId)}`
  );
  return { organizationId, organization };
}

/** The organization-wide API-key IP allowlist; empty when unrestricted. */
export async function loadOrganizationIpAllowlist(): Promise<OrganizationIpAllowlist> {
  try {
    const { organizationId, organization } = await readOrganization();
    return {
      ok: true,
      organizationId,
      allowedIps: organizationAllowlistSchema.parse(organization),
    };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}

/** Whether the organization's admins get alert emails (HOO-2299); on unless turned off. */
export async function loadOrganizationAlertEmails(): Promise<OrganizationAlertEmails> {
  try {
    const { organizationId, organization } = await readOrganization();
    return { ok: true, organizationId, enabled: organizationAlertEmailsSchema.parse(organization) };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}
