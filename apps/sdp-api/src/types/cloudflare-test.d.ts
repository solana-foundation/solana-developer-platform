import type { Env } from "@/types/env";

declare module "cloudflare:workers" {
  const env: Env;
  export { env };
}
