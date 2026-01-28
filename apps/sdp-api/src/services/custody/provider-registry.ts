/**
 * Custody Provider Registry
 *
 * Maps custody provider types to concrete provider factories.
 */

import type { Env } from "@/types/env";

import { FireblocksProvider, parseFireblocksConfig } from "./fireblocks/provider";
import { LocalKeypairProvider } from "./local-keypair.provider";
import type { CustodyConfigRecord, CustodyProvider, CustodyProviderType } from "./types";

export type CustodyProviderFactory = (config: CustodyConfigRecord, env: Env) => CustodyProvider;

export class CustodyProviderRegistry {
  private factories = new Map<CustodyProviderType, CustodyProviderFactory>();

  register(type: CustodyProviderType, factory: CustodyProviderFactory): void {
    this.factories.set(type, factory);
  }

  createProvider(config: CustodyConfigRecord, env: Env): CustodyProvider {
    const factory = this.factories.get(config.provider);
    if (!factory) {
      throw new Error(`Custody provider not registered: ${config.provider}`);
    }

    return factory(config, env);
  }
}

export function createDefaultRegistry(): CustodyProviderRegistry {
  const registry = new CustodyProviderRegistry();

  registry.register("local", (_config, env) => new LocalKeypairProvider(env));
  registry.register(
    "fireblocks",
    (config) => new FireblocksProvider(parseFireblocksConfig(config))
  );
  registry.register("dfns", () => {
    throw new Error("Dfns provider not yet implemented");
  });
  registry.register("turnkey", () => {
    throw new Error("Turnkey provider not yet implemented");
  });

  return registry;
}
