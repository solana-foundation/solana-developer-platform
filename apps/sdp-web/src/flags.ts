import { vercelAdapter } from "@flags-sdk/vercel";
import { flag } from "flags/next";

export const homepageOpenSignup = flag<boolean>({
  key: "homepage-open-signup",
  adapter: vercelAdapter(),
  defaultValue: process.env.VERCEL_ENV !== "production",
  description: "Show self-serve signup and contact CTAs instead of the homepage waitlist CTA.",
  options: [
    { value: false, label: "Waitlist" },
    { value: true, label: "Open signup" },
  ],
});
