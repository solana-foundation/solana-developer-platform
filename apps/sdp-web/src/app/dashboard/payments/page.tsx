import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolvePlaygroundApiBaseUrl } from "../playground-api-data";
import { PaymentsWarmPage } from "./payments-warm-page";

export default async function PaymentsPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return <PaymentsWarmPage apiBaseUrl={resolvePlaygroundApiBaseUrl()} />;
}
