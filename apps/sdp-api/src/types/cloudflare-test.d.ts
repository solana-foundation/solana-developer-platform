import type { Env } from "@/types/env";

declare module "cloudflare:test" {
  const env: Env;
  export { env };
}
