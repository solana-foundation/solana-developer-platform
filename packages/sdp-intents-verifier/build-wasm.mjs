// Builds the verifier crate for WebAssembly and copies the module to `wasm/verifier.wasm`. Cargo
// runs in `intents/`, so it uses the toolchain that `intents/rust-toolchain.toml` pins.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

const INTENTS = new URL("../../intents/", import.meta.url).pathname;
const TARGET = "wasm32-unknown-unknown";
const BUILT = `${INTENTS}target/${TARGET}/release/sdp_intents_verifier_wasm.wasm`;
const OUT = new URL("./wasm/", import.meta.url).pathname;

execFileSync(
  "cargo",
  ["build", "--release", "-p", "sdp-intents-verifier-wasm", "--target", TARGET],
  { cwd: INTENTS, stdio: "inherit" }
);
mkdirSync(OUT, { recursive: true });
copyFileSync(BUILT, `${OUT}verifier.wasm`);
