import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SettingsWorkspace } from "./settings-workspace";

export default async function SettingsPage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }
  return <SettingsWorkspace />;
}
