import type { SdpModule } from "@sdp/types/release-channels";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flags: {
    issuance: vi.fn<() => Promise<boolean>>(),
    assetProfiles: vi.fn<() => Promise<boolean>>(),
    privateChannels: vi.fn<() => Promise<boolean>>(),
    heliusRings: vi.fn<() => Promise<boolean>>(),
    markets: vi.fn<() => Promise<boolean>>(),
    dvp: vi.fn<() => Promise<boolean>>(),
    earn: vi.fn<() => Promise<boolean>>(),
  },
  isModuleInProjectReleaseChannel: vi.fn<(module: SdpModule) => Promise<boolean>>(),
}));

vi.mock("@/flags", () => mocks.flags);
vi.mock("@/flags/project-release-channel", () => ({
  isModuleInProjectReleaseChannel: mocks.isModuleInProjectReleaseChannel,
}));

import {
  assetProfiles,
  dvp,
  earn,
  heliusRings,
  issuance,
  markets,
  privateChannels,
} from "./project-modules";

const READERS = [
  { name: "issuance", reader: issuance, module: "issuance" },
  { name: "assetProfiles", reader: assetProfiles, module: "issuance" },
  { name: "privateChannels", reader: privateChannels, module: "private_channels" },
  { name: "heliusRings", reader: heliusRings, module: "helius_rings" },
  { name: "markets", reader: markets, module: "markets" },
  { name: "dvp", reader: dvp, module: "dvp" },
  { name: "earn", reader: earn, module: "earn" },
] as const satisfies readonly {
  name: keyof typeof mocks.flags;
  reader: () => Promise<boolean>;
  module: SdpModule;
}[];

describe("project module flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const flag of Object.values(mocks.flags)) {
      flag.mockResolvedValue(false);
    }
  });

  it.each(READERS)(
    "$name is off without reading its flag when the Project's environment leaves $module out",
    async ({ name, reader, module }) => {
      mocks.isModuleInProjectReleaseChannel.mockResolvedValue(false);
      mocks.flags[name].mockResolvedValue(true);

      await expect(reader()).resolves.toBe(false);
      expect(mocks.isModuleInProjectReleaseChannel).toHaveBeenCalledWith(module);
      expect(mocks.flags[name]).not.toHaveBeenCalled();
    }
  );

  it.each(READERS)(
    "$name follows its own flag when the Project's environment runs $module",
    async ({ name, reader, module }) => {
      mocks.isModuleInProjectReleaseChannel.mockResolvedValue(true);

      await expect(reader()).resolves.toBe(false);
      mocks.flags[name].mockResolvedValue(true);
      await expect(reader()).resolves.toBe(true);
      expect(mocks.isModuleInProjectReleaseChannel).toHaveBeenCalledWith(module);
    }
  );
});
