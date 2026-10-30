"use server";

import { COUNTRY_CODES, type CountryCode } from "@sdp/types/countries";
import { MAINNET_ACCESS_STATES, type MainnetAccess } from "@sdp/types/mainnet-access";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createOrgSdpApiClient, requestProjectHref } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";
import { resolveOrganizationId } from "./organization-id";

const mainnetAccessSchema = z.object({
  state: z.enum(MAINNET_ACCESS_STATES),
  available: z.boolean(),
  countryCode: z.enum(COUNTRY_CODES).nullable(),
  request: z
    .object({
      requestedAt: z.string(),
      requestedByUserId: z.string(),
      termsVersion: z.string(),
      notified: z.boolean(),
    })
    .nullable(),
  contactEmail: z.string().nullable(),
}) satisfies z.ZodType<MainnetAccess>;

const organizationNameSchema = z.object({ name: z.string() });

export type MainnetAccessLoad =
  | { ok: true; organizationName: string; access: MainnetAccess }
  | { ok: false; error: string };

export type RequestMainnetAccessResult =
  | { ok: true; access: MainnetAccess }
  | { ok: false; error: string };

function mainnetAccessPath(organizationId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationId)}/mainnet-access`;
}

/** Where the signed-in organization's mainnet access stands, with the name an admin accepts for. */
export async function loadMainnetAccess(): Promise<MainnetAccessLoad> {
  try {
    const client = await createOrgSdpApiClient();
    const organizationId = await resolveOrganizationId(client);
    const [access, organization] = await Promise.all([
      client.fetch<unknown>(mainnetAccessPath(organizationId)),
      client.fetch<unknown>(`/v1/organizations/${encodeURIComponent(organizationId)}`),
    ]);
    return {
      ok: true,
      organizationName: organizationNameSchema.parse(organization).name,
      access: mainnetAccessSchema.parse(access),
    };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}

/**
 * Sends the one-time request: the jurisdiction and the terms version the admin accepted. The
 * API refuses a second request, so a retried submit cannot ask twice; a request whose email
 * did not go out is sent with {@link notifyMainnetAccessAction}.
 */
export async function requestMainnetAccessAction(input: {
  countryCode: CountryCode;
  termsVersion: string;
}): Promise<RequestMainnetAccessResult> {
  try {
    const client = await createOrgSdpApiClient();
    const organizationId = await resolveOrganizationId(client);
    const access = mainnetAccessSchema.parse(
      await client.fetch<unknown>(mainnetAccessPath(organizationId), {
        method: "POST",
        body: JSON.stringify({
          countryCode: input.countryCode,
          termsVersion: input.termsVersion,
          acceptTerms: true,
        }),
      })
    );
    return { ok: true, access };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  } finally {
    // A refused submit may still have recorded the request when only its email failed.
    revalidatePath(await requestProjectHref("/dashboard/settings"), "page");
  }
}

/** Sends the recorded request whose email did not go out. */
export async function notifyMainnetAccessAction(): Promise<RequestMainnetAccessResult> {
  try {
    const client = await createOrgSdpApiClient();
    const organizationId = await resolveOrganizationId(client);
    const access = mainnetAccessSchema.parse(
      await client.fetch<unknown>(`${mainnetAccessPath(organizationId)}/notify`, { method: "POST" })
    );
    return { ok: true, access };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  } finally {
    revalidatePath(await requestProjectHref("/dashboard/settings"), "page");
  }
}
