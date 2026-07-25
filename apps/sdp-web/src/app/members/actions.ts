"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "@/i18n/server";
// Project-scoped, not org-scoped: /v1/members applies projectContextMiddleware
// to every route (routes/members/index.ts), so it rejects a request without an
// x-project-id header even though membership itself is organization-level.
import { createSdpApiClient } from "@/lib/sdp-api";

export interface Member {
  id: string;
  role: string;
  status: string;
  createdAt: string;
  user: {
    id: string;
    email: string;
    name: string | null;
  };
}

/**
 * SDP API failures arrive as `SDP API request failed (400): {"error":{…}}`.
 * Rendering that verbatim puts a JSON blob in front of the user, so pull out
 * the message the API actually wrote and fall back to the raw text.
 */
export function readableApiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) {
    return raw;
  }

  try {
    const parsed = JSON.parse(raw.slice(jsonStart)) as {
      error?: { message?: string };
      message?: string;
    };
    return parsed.error?.message ?? parsed.message ?? raw;
  } catch {
    return raw;
  }
}

export async function listMembers(): Promise<Member[]> {
  const client = await createSdpApiClient();
  const response = await client.fetch<{ members: Member[] }>("/v1/members");
  return response.members;
}

export type InviteMemberResult = { ok: true; email: string } | { ok: false; error: string };

/**
 * Returns the failure instead of throwing so the form can render it inline. A
 * thrown server action surfaces as an error boundary, which discards the
 * typed-in address and tells the user nothing actionable.
 */
export async function inviteMember(formData: FormData): Promise<InviteMemberResult> {
  const t = await getTranslations();
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "member").trim();

  if (!email) {
    return { ok: false, error: t("Shared.members.emailRequired") };
  }

  try {
    const client = await createSdpApiClient();
    await client.fetch("/v1/members/invite", {
      method: "POST",
      body: JSON.stringify({ email, role }),
    });
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }

  // The page lives at /dashboard/members; /members only redirects there.
  revalidatePath("/dashboard/members");
  return { ok: true, email };
}
