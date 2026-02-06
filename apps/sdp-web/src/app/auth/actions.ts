"use server";

import { auth } from "@clerk/nextjs/server";

export async function startSignIn() {
  const { redirectToSignIn } = await auth();
  return redirectToSignIn({ returnBackUrl: "/dashboard" });
}

export async function startSignUp() {
  const { redirectToSignUp } = await auth();
  return redirectToSignUp({ returnBackUrl: "/dashboard" });
}
