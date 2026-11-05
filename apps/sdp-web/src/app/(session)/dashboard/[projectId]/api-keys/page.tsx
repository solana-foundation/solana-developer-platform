import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { ApiKeysWorkspace } from "./api-keys-workspace";

export default async function ApiKeysPage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }
  return <ApiKeysWorkspace />;
}
