"use server";

import { revalidatePath } from "next/cache";
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

export async function inviteMember(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "member").trim();

  if (!email) {
    throw new Error("Email is required");
  }

  const client = await createOrgSdpApiClient();
  await client.fetch("/v1/members/invite", {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });

  revalidatePath("/members");
}
