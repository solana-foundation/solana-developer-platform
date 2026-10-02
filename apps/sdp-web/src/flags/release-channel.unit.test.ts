import type { Adapter } from "flags";
import { describe, expect, it } from "vitest";
import { capAdapterToReleaseChannel } from "./release-channel";

const servesOn: Adapter<boolean, never> = {
  origin: "https://vercel.com/flags",
  decide: () => true,
};

function decide(adapter: Adapter<boolean, never>) {
  // SAFETY: neither adapter under test reads cookies; a real cookie store needs a request.
  return adapter.decide({ key: "flag", headers: new Headers(), cookies: new Map() as never });
}

describe("capAdapterToReleaseChannel", () => {
  it("keeps the flag's own adapter inside the release channel", () => {
    expect(capAdapterToReleaseChannel(true, servesOn)).toBe(servesOn);
  });

  it("turns the flag off outside it whatever its adapter would serve", async () => {
    const capped = capAdapterToReleaseChannel(false, servesOn);
    expect(await decide(capped)).toBe(false);
    expect(capped.origin).toBe(servesOn.origin);
  });
});
