"use server";

import { z } from "zod";
import { readOrganizationLinked } from "@/lib/sdp-api";
import { getSdpAuth } from "@/lib/sdp-auth";

// A person's Clerk organizations, as one page of the switcher loads them, fit well under this.
const MAX_ORGANIZATIONS_PER_READ = 100;

const tokensSchema = z.array(z.string().min(1)).max(MAX_ORGANIZATIONS_PER_READ);

/**
 * Which of the signed-in person's Clerk organizations this deployment links, one
 * session token per organization (the browser mints them, since a token names a
 * single organization).
 *
 * @param tokens - Clerk session tokens, each minted for one organization.
 * @returns For each token, whether SDP links its organization.
 */
export async function readOrganizationsLinked(tokens: string[]): Promise<boolean[]> {
  const parsedTokens = tokensSchema.parse(tokens);
  const { userId } = await getSdpAuth();
  if (!userId) {
    throw new Error("Sign-in required");
  }
  return Promise.all(parsedTokens.map((token) => readOrganizationLinked(token)));
}
