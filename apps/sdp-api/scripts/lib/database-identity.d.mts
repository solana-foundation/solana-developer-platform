/**
 * Type surface for scripts/lib/database-identity.mjs, consumed by
 * src/db/identity.ts. Keep structurally identical to the runtime module.
 */

export declare class DatabaseIdentityError extends Error {
  constructor(message: string);
}

export type DatabaseIdentityConfig =
  | { readonly kind: "tenant"; readonly organizationId: string }
  | { readonly kind: "system"; readonly component: string }
  | { readonly kind: "operator"; readonly actor: string; readonly reason: string }
  | { readonly kind: "none"; readonly component: string };

export declare function databaseIdentityConfigStatement(identity: DatabaseIdentityConfig): {
  text: string;
};

export declare function databaseIdentitySessionConfigStatement(identity: DatabaseIdentityConfig): {
  text: string;
};
