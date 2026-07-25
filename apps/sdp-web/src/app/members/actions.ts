"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "@/i18n/server";
import { createOrgSdpApiClient } from "@/lib/sdp-api";

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

export async function listMembers(): Promise<Member[]> {
  const client = await createOrgSdpApiClient();
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
    const client = await createOrgSdpApiClient();
    await client.fetch("/v1/members/invite", {
      method: "POST",
      body: JSON.stringify({ email, role }),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  // The page lives at /dashboard/members; /members only redirects there.
  revalidatePath("/dashboard/members");
  return { ok: true, email };
}
