import { auth } from "@clerk/nextjs/server";
import { cache } from "react";

/**
 * Clerk's auth state for the current request, resolved once per request.
 * @returns the request's Clerk auth object
 */
export const getSdpAuth = cache(async () => auth());
