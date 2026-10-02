import type { ReactNode } from "react";
import {
  newDesign,
  newDesignActivity,
  newDesignContacts,
  newDesignIssuance,
  newDesignOverview,
  newDesignPayDeposit,
  newDesignWallets,
} from "@/flags";
import type { DesignModule, DesignModuleFlags } from "@/lib/design-modules";

type Page<P> = (props: P) => ReactNode | Promise<ReactNode>;
type ModuleFlag = () => Promise<boolean>;

// Each design module's own flag (lib/design-modules.ts). It counts only while NEW DESIGN is on.
const DESIGN_MODULE_FLAGS: Record<DesignModule, ModuleFlag> = {
  overview: newDesignOverview,
  wallets: newDesignWallets,
  issuance: newDesignIssuance,
  contacts: newDesignContacts,
  payDeposit: newDesignPayDeposit,
  activity: newDesignActivity,
};

/**
 * Evaluates every design module's own flag for this request, NEW DESIGN aside.
 *
 * @returns Each module's flag value.
 */
export async function getDesignModuleFlags(): Promise<DesignModuleFlags> {
  const entries = await Promise.all(
    (Object.entries(DESIGN_MODULE_FLAGS) as [DesignModule, ModuleFlag][]).map(
      async ([designModule, flag]) => [designModule, await flag()]
    )
  );
  return Object.fromEntries(entries);
}

/**
 * Whether this request renders in the new design: NEW DESIGN is on and, for a design module,
 * so is the module's own flag.
 *
 * @param designModule - The redesigned area, or none for NEW DESIGN alone.
 * @returns True for the new design.
 */
export async function isNewDesignOn(designModule?: DesignModule): Promise<boolean> {
  if (!(await newDesign())) {
    return false;
  }
  if (!designModule) {
    return true;
  }
  const moduleFlag: ModuleFlag = DESIGN_MODULE_FLAGS[designModule];
  return moduleFlag();
}

/**
 * A route that has a new-design page and a previous-design one: NEW DESIGN and the route's
 * design module flag pick which renders, per request. Lives beside the flag definitions rather
 * than in index.ts, which may export only flags (the discovery endpoint serves it wholesale).
 *
 * @param Current - The page on the new design.
 * @param Legacy - The previous design's page, the route's own code from before the redesign.
 * @param designModule - The redesigned area the route belongs to, or none for NEW DESIGN alone.
 * @returns The route's page.
 */
export function withLegacyDesign<P extends object>(
  Current: Page<P>,
  Legacy: Page<P>,
  designModule?: DesignModule
) {
  // Called rather than rendered, so the route returns exactly what the chosen page returns.
  return async function DesignedPage(props: P): Promise<ReactNode> {
    return (await isNewDesignOn(designModule)) ? Current(props) : Legacy(props);
  };
}
