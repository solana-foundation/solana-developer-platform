"use server";

import { revalidatePath } from "next/cache";
import type { OnboardingStatusResponse } from "@/app/dashboard/[projectId]/onboarding-status";
import { parseAllowedIps } from "@/lib/ip-allowlist-input";
import { createOrgSdpApiClient, requestProjectHref } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";

interface OrganizationSettingsResponse {
  settings?: { allowedIpAddresses?: string[] } | null;
}

export type OrganizationIpAllowlist =
  | { ok: true; organizationId: string; allowedIps: string[] }
  | { ok: false; error: string };

export type SaveOrganizationIpAllowlistResult =
  | { ok: true; allowedIps: string[] }
  | { ok: false; error: string };

/** The signed-in organization's SDP id, from the onboarding status. */
async function resolveOrganizationId(
  client: Awaited<ReturnType<typeof createOrgSdpApiClient>>
): Promise<string> {
  const onboarding = await client.fetch<OnboardingStatusResponse>("/v1/onboarding/status");
  if (!onboarding.linked || !onboarding.organization) {
    throw new Error("Organization is not linked yet");
  }
  return onboarding.organization.id;
}

/** The organization-wide API-key IP allowlist; empty when unrestricted. */
export async function loadOrganizationIpAllowlist(): Promise<OrganizationIpAllowlist> {
  try {
    const client = await createOrgSdpApiClient();
    const organizationId = await resolveOrganizationId(client);
    const organization = await client.fetch<OrganizationSettingsResponse>(
      `/v1/organizations/${encodeURIComponent(organizationId)}`
    );
    return {
      ok: true,
      organizationId,
      allowedIps: organization.settings?.allowedIpAddresses ?? [],
    };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}

/**
 * Replaces the organization's API-key IP allowlist. An empty value clears it.
 * The API canonicalizes each entry, so the saved list is what it returns.
 */
export async function saveOrganizationIpAllowlistAction(
  value: string
): Promise<SaveOrganizationIpAllowlistResult> {
  try {
    const client = await createOrgSdpApiClient();
    const organizationId = await resolveOrganizationId(client);
    const organization = await client.fetch<OrganizationSettingsResponse>(
      `/v1/organizations/${encodeURIComponent(organizationId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ settings: { allowedIpAddresses: parseAllowedIps(value) } }),
      }
    );
    revalidatePath(await requestProjectHref("/dashboard/settings"), "page");
    return { ok: true, allowedIps: organization.settings?.allowedIpAddresses ?? [] };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}
