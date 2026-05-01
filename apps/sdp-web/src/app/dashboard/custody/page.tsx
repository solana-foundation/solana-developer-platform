import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolvePlaygroundApiBaseUrl } from "../playground-api-data";
import { CustodyWarmPage } from "./custody-warm-page";

export default async function CustodyPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return <CustodyWarmPage apiBaseUrl={resolvePlaygroundApiBaseUrl()} />;
}
