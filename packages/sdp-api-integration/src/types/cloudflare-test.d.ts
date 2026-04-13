import type { Env } from "@sdp/api/types/env";

declare module "cloudflare:workers" {
  const env: Env;
  export { env };
}
