import { z } from "zod";

const SECRET_VERSION_NAME =
  /^projects\/[a-z0-9-]{1,63}\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/[1-9][0-9]*$/;

const taggedReference = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("platform") }),
  z.strictObject({
    kind: z.literal("secret_manager_version"),
    name: z.string().regex(SECRET_VERSION_NAME),
  }),
]);

// The credential header's value: `platform`, or `secret_manager_version:<version name>`.
export const credentialReferenceSchema = z
  .string()
  .transform((wire) => {
    const separator = wire.indexOf(":");
    return separator === -1
      ? { kind: wire }
      : { kind: wire.slice(0, separator), name: wire.slice(separator + 1) };
  })
  .pipe(taggedReference);

export type CredentialReference = z.infer<typeof credentialReferenceSchema>;
