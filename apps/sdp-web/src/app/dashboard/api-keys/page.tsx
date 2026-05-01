import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { ApiKeysWarmPage } from "./api-keys-warm-page";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return <ApiKeysWarmPage />;
}
