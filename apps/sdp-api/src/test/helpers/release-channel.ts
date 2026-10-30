import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import { vi } from "vitest";

/**
 * Run the current test on `releaseChannel`: stubs `SDP_RELEASE_CHANNEL`, which
 * `deploymentReleaseChannel()` reads from the process env. `src/test/setup.ts`
 * restores the `experimental` default after every test, so call it from the test
 * or a `beforeEach`, never a `beforeAll`.
 *
 * @param releaseChannel - The deployment's release channel for the current test;
 *   `undefined` unsets it, as on a deployment that never configured one.
 */
export function stubReleaseChannel(releaseChannel: SdpReleaseChannel | undefined): void {
  vi.stubEnv("SDP_RELEASE_CHANNEL", releaseChannel);
}
