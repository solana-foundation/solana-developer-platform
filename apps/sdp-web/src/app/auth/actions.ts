"use server";

import { isAuthEntryEnabled } from "@/lib/auth-entry";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export async function startSignIn() {
  if (!isAuthEntryEnabled()) {
    redirect("/");
  }

  const { redirectToSignIn } = await auth();
  return redirectToSignIn({ returnBackUrl: "/dashboard" });
}

export async function startSignUp() {
  if (!isAuthEntryEnabled()) {
    redirect("/");
  }

  const { redirectToSignUp } = await auth();
  return redirectToSignUp({ returnBackUrl: "/dashboard" });
}
