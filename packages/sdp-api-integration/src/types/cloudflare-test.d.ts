import type { Env } from "@sdp/api/types/env";

declare module "cloudflare:test" {
  const env: Env;
  export { env };
}
