"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import { parseAllowedIps } from "@/lib/ip-allowlist-input";
import { createOrgSdpApiClient, requestProjectHref } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";
import { resolveOrganizationId } from "./organization-id";

/** The organization read; an absent allowlist is an unrestricted one. */
const organizationAllowlistSchema = z.object({
  settings: z.object({ allowedIpAddresses: z.array(z.string()).optional() }).nullable(),
});

function parseAllowlist(body: unknown): string[] {
  return organizationAllowlistSchema.parse(body).settings?.allowedIpAddresses ?? [];
}

export type OrganizationIpAllowlist =
  | { ok: true; organizationId: string; allowedIps: string[] }
  | { ok: false; error: string };

export type SaveOrganizationIpAllowlistResult =
  | { ok: true; allowedIps: string[] }
  | { ok: false; error: string };

/** The organization-wide API-key IP allowlist; empty when unrestricted. */
export async function loadOrganizationIpAllowlist(): Promise<OrganizationIpAllowlist> {
  try {
    const client = await createOrgSdpApiClient();
    const organizationId = await resolveOrganizationId(client);
    const organization = await client.fetch<unknown>(
      `/v1/organizations/${encodeURIComponent(organizationId)}`
    );
    return { ok: true, organizationId, allowedIps: parseAllowlist(organization) };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}

/**
 * Replaces the organization's API-key IP allowlist. An empty value clears it.
 * The API canonicalizes each entry, so the saved list is what it returns.
 * The form's Idempotency-Key is forwarded, one per edit, so a retried save
 * is the same request.
 */
export async function saveOrganizationIpAllowlistAction(
  value: string,
  idempotencyKey: string
): Promise<SaveOrganizationIpAllowlistResult> {
  try {
    const client = await createOrgSdpApiClient();
    const organizationId = await resolveOrganizationId(client);
    const organization = await client.fetch<unknown>(
      `/v1/organizations/${encodeURIComponent(organizationId)}`,
      {
        method: "PATCH",
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
        body: JSON.stringify({ settings: { allowedIpAddresses: parseAllowedIps(value) } }),
      }
    );
    revalidatePath(await requestProjectHref("/dashboard/settings"), "page");
    return { ok: true, allowedIps: parseAllowlist(organization) };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}

/** The organization read; an unset `alertEmails` means alert emails are on. */
const organizationAlertEmailsSchema = z.object({
  settings: z.object({ alertEmails: z.boolean().optional() }).nullable(),
});

function parseAlertEmails(body: unknown): boolean {
  return organizationAlertEmailsSchema.parse(body).settings?.alertEmails !== false;
}

export type OrganizationAlertEmails = { ok: true; enabled: boolean } | { ok: false; error: string };

/** Whether the organization's admins get alert emails (HOO-2299); on unless turned off. */
export async function loadOrganizationAlertEmails(): Promise<OrganizationAlertEmails> {
  try {
    const client = await createOrgSdpApiClient();
    const organizationId = await resolveOrganizationId(client);
    const organization = await client.fetch<unknown>(
      `/v1/organizations/${encodeURIComponent(organizationId)}`
    );
    return { ok: true, enabled: parseAlertEmails(organization) };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}

/**
 * Turns every alert email to the organization's admins on or off; the saved
 * value is what the API returns. The switch's Idempotency-Key is forwarded,
 * one per intended value, so a retried save is the same request.
 */
export async function saveOrganizationAlertEmailsAction(
  enabled: boolean,
  idempotencyKey: string
): Promise<OrganizationAlertEmails> {
  try {
    const client = await createOrgSdpApiClient();
    const organizationId = await resolveOrganizationId(client);
    const organization = await client.fetch<unknown>(
      `/v1/organizations/${encodeURIComponent(organizationId)}`,
      {
        method: "PATCH",
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
        body: JSON.stringify({ settings: { alertEmails: enabled } }),
      }
    );
    revalidatePath(await requestProjectHref("/dashboard/settings"), "page");
    return { ok: true, enabled: parseAlertEmails(organization) };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}
