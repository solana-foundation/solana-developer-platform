"use server";

import { isSignInEntryEnabled, isSignUpEntryEnabled } from "@/lib/auth-entry";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export async function startSignIn() {
  if (!(await isSignInEntryEnabled())) {
    redirect("/");
  }

  const { redirectToSignIn } = await auth();
  return redirectToSignIn({ returnBackUrl: "/dashboard" });
}

export async function startSignUp() {
  if (!(await isSignUpEntryEnabled())) {
    redirect("/");
  }

  const { redirectToSignUp } = await auth();
  return redirectToSignUp({ returnBackUrl: "/dashboard" });
}
