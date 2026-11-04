import { z } from "zod";
import { createOrgSdpApiClient } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";
import { resolveOrganizationId } from "./organization-id";
import {
  organizationAlertEmailsSchema,
  organizationAllowlistSchema,
} from "./organization-settings";

const loadFailureSchema = z.object({ ok: z.literal(false), error: z.string() });

const organizationIpAllowlistLoadSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), organizationId: z.string(), allowedIps: z.array(z.string()) }),
  loadFailureSchema,
]);

const organizationAlertEmailsLoadSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), organizationId: z.string(), enabled: z.boolean() }),
  loadFailureSchema,
]);

async function readOrganization<T>(
  settingSchema: z.ZodType<T>
): Promise<{ organizationId: string; setting: T }> {
  const client = await createOrgSdpApiClient();
  const organizationId = await resolveOrganizationId(client);
  const organization = await client.fetch<unknown>(
    `/v1/organizations/${encodeURIComponent(organizationId)}`
  );
  return { organizationId, setting: settingSchema.parse(organization) };
}

/** The organization-wide API-key IP allowlist; empty when unrestricted. */
export async function loadOrganizationIpAllowlist(): Promise<
  z.infer<typeof organizationIpAllowlistLoadSchema>
> {
  try {
    const { organizationId, setting } = await readOrganization(organizationAllowlistSchema);
    return { ok: true, organizationId, allowedIps: setting };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}

/** Whether the organization's admins get alert emails (HOO-2299); on unless turned off. */
export async function loadOrganizationAlertEmails(): Promise<
  z.infer<typeof organizationAlertEmailsLoadSchema>
> {
  try {
    const { organizationId, setting } = await readOrganization(organizationAlertEmailsSchema);
    return { ok: true, organizationId, enabled: setting };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}
