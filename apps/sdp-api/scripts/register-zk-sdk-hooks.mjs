/**
 * Preload entry for `zk-sdk-node-hooks.mjs`.
 *
 * Pass as `node --import ./scripts/register-zk-sdk-hooks.mjs ...` so the
 * resolve hook is installed before any application module loads. See the hook
 * for why the redirect exists.
 */

import { register } from "node:module";

register("./zk-sdk-node-hooks.mjs", import.meta.url);
