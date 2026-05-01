import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolvePlaygroundApiBaseUrl } from "../playground-api-data";
import { IssuanceWarmPage } from "./issuance-warm-page";

export default async function IssuancePage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return <IssuanceWarmPage apiBaseUrl={resolvePlaygroundApiBaseUrl()} />;
}
