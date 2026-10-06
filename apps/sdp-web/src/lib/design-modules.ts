/**
 * NEW DESIGN rolls out one dashboard area at a time. NEW DESIGN itself turns on the new shell
 * (palette, faces, sidebar, the language switch) and the Privacy connect form; each redesigned
 * area, a design module, also has a flag of its own that turns on that area's new pages. A
 * module's flag counts only while NEW DESIGN is on, the way DvP needs Markets.
 *
 * A redesigned area adds its routes here, its flag in flags/index.ts and the flag's entry in
 * flags/new-design.ts. The first matching route wins, so a catch-all module goes last.
 */
const DESIGN_MODULE_ROUTES = {} satisfies Record<string, RegExp>;

export type DesignModule = keyof typeof DESIGN_MODULE_ROUTES;

export type DesignModuleFlags = Partial<Record<DesignModule, boolean>>;

/** The flags that pick a page's design. */
export type DesignFlags = {
  newDesign?: boolean;
  /** Each design module's own flag; a module absent here (older fixtures) follows NEW DESIGN. */
  newDesignModules?: DesignModuleFlags;
};

const PAYMENTS_ROUTE = /^\/dashboard\/payments(?:\/|$)/;

/**
 * Whether a design module's new pages are on: NEW DESIGN and the module's own flag both are.
 *
 * @param flags - The dashboard's flags, or none outside the dashboard workspace.
 * @param designModule - The module.
 * @returns True when the module renders in the new design.
 */
export function isDesignModuleOn(
  flags: DesignFlags | null | undefined,
  designModule: DesignModule
): boolean {
  return flags?.newDesign === true && flags.newDesignModules?.[designModule] !== false;
}

/**
 * The design module a dashboard route belongs to.
 *
 * @param pathname - The dashboard route.
 * @returns The module, or null for a route no module has redesigned.
 */
export function designModuleForPath(pathname: string): DesignModule | null {
  for (const [designModule, route] of Object.entries(DESIGN_MODULE_ROUTES) as [
    DesignModule,
    RegExp,
  ][]) {
    if (route.test(pathname)) {
      return designModule;
    }
  }
  return null;
}

/**
 * Whether a dashboard page renders in the new design. A module's page follows its module's flag.
 * A Payments page no module has redesigned keeps the previous design; any other page follows
 * NEW DESIGN alone.
 *
 * @param pathname - The dashboard route.
 * @param flags - The dashboard's flags, or none outside the dashboard workspace.
 * @returns True when the page renders in the new design.
 */
export function isNewDesignPage(pathname: string, flags: DesignFlags | null | undefined): boolean {
  if (flags?.newDesign !== true) {
    return false;
  }
  const designModule = designModuleForPath(pathname);
  if (designModule) {
    return isDesignModuleOn(flags, designModule);
  }
  return !PAYMENTS_ROUTE.test(pathname);
}
