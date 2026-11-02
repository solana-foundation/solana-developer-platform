import { createClerkClient } from "@clerk/backend";
import { z } from "zod";

/**
 * HOO-2469: deletes every organization and user on the Clerk instance behind CLERK_SECRET_KEY.
 * Prints the counts by default; `--apply` deletes.
 */

// Production instances allow 1000 requests per 10 seconds; a development instance (100) will 429.
const DELETE_BATCH_SIZE = 10;

const envSchema = z.object({ CLERK_SECRET_KEY: z.string().regex(/^sk_(test|live)_/) });

async function deleteAll(
  kind: string,
  listFirstPage: () => Promise<{ data: { id: string }[] }>,
  remove: (id: string) => Promise<{ id: string }>
): Promise<void> {
  for (let page = await listFirstPage(); page.data.length > 0; page = await listFirstPage()) {
    for (let start = 0; start < page.data.length; start += DELETE_BATCH_SIZE) {
      await Promise.all(
        page.data.slice(start, start + DELETE_BATCH_SIZE).map(async ({ id }) => {
          await remove(id);
          console.log(`deleted ${kind} ${id}`);
        })
      );
    }
  }
}

async function main(): Promise<void> {
  const { CLERK_SECRET_KEY } = envSchema.parse(process.env);
  const clerk = createClerkClient({ secretKey: CLERK_SECRET_KEY });
  const instance = CLERK_SECRET_KEY.startsWith("sk_live_") ? "production" : "development";
  const organizations = (await clerk.organizations.getOrganizationList({ limit: 1 })).totalCount;
  const users = await clerk.users.getCount();
  console.log(`${instance} instance: ${organizations} organizations, ${users} users`);
  if (!process.argv.includes("--apply")) return;

  await deleteAll(
    "organization",
    () => clerk.organizations.getOrganizationList({ limit: 100 }),
    (id) => clerk.organizations.deleteOrganization(id)
  );
  await deleteAll(
    "user",
    () => clerk.users.getUserList({ limit: 100 }),
    (id) => clerk.users.deleteUser(id)
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
