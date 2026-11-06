"use server";

import { z } from "zod";
import { createSignupSdpApiClient } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";

export type CreateOrganizationResult =
  | { ok: true; clerkOrganizationId: string }
  | { ok: false; error: string };

const createdOrganizationSchema = z.object({ clerkOrganizationId: z.string() });

/**
 * Creates the signed-in person's organization in SDP (ADR 0012). The session
 * names no organization SDP links; the caller makes the returned Clerk
 * organization active. Repeating it with the same name finishes or returns the same
 * organization, so the form may resubmit after a failure.
 *
 * @param name - The organization's name.
 * @returns The Clerk organization to make active, or the API's refusal.
 */
export async function createOrganization(name: string): Promise<CreateOrganizationResult> {
  const parsedName = z.string().trim().min(1).max(100).parse(name);
  try {
    const client = await createSignupSdpApiClient();
    const created = createdOrganizationSchema.parse(
      await client.fetch<unknown>("/v1/organizations", {
        method: "POST",
        body: JSON.stringify({ name: parsedName }),
      })
    );
    return { ok: true, clerkOrganizationId: created.clerkOrganizationId };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}
