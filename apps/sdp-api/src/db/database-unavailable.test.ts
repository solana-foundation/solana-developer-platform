/**
 * The failures that mean "the database could not take the work", as the real
 * driver and a real server produce them. The classifier matches pg-pool's own
 * wording, so a driver upgrade that rewords it fails here instead of quietly
 * turning the API's 503s back into 500s.
 */

import net from "node:net";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { isDatabaseUnavailableCause } from "@/db/client";
import { adminDatabaseUrl } from "@/test/helpers/env";

const workerId = process.env.VITEST_POOL_ID;
if (!workerId) {
  throw new Error("Test environment requires VITEST_POOL_ID (unit tests must run under vitest).");
}

/** The error `attempt` fails with; the test fails if it succeeds. */
async function failureOf<T>(attempt: Promise<T>): Promise<Error> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the attempt to fail");
}

describe("isDatabaseUnavailableCause with the real driver", () => {
  it("recognizes a pool whose connections are all in use", async () => {
    const pool = new pg.Pool({
      connectionString: adminDatabaseUrl,
      max: 1,
      connectionTimeoutMillis: 100,
    });
    const held = await pool.connect();
    try {
      expect(isDatabaseUnavailableCause(await failureOf(pool.connect()))).toBe(true);
    } finally {
      held.release();
      await pool.end();
    }
  });

  it("recognizes a connection that does not finish opening in time", async () => {
    // Accepts the socket and never answers the startup message.
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const address = silent.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected the silent server to listen on a TCP port");
    }
    const pool = new pg.Pool({
      host: "127.0.0.1",
      port: address.port,
      user: "sdp",
      database: "sdp",
      connectionTimeoutMillis: 100,
    });
    try {
      expect(isDatabaseUnavailableCause(await failureOf(pool.connect()))).toBe(true);
    } finally {
      await pool.end();
      for (const socket of sockets) {
        socket.destroy();
      }
      silent.close();
    }
  });

  it("recognizes a login the server refuses for lack of connection slots", async () => {
    const role = `sdp_no_slots_${workerId}`;
    const admin = new pg.Client({ connectionString: adminDatabaseUrl });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'no-slots' CONNECTION LIMIT 0`);
      const url = new URL(adminDatabaseUrl);
      url.username = role;
      url.password = "no-slots";

      const refused = await failureOf(
        new pg.Client({ connectionString: url.toString() }).connect()
      );

      expect(refused).toBeInstanceOf(pg.DatabaseError);
      expect(refused).toMatchObject({ code: "53300" });
      expect(isDatabaseUnavailableCause(refused)).toBe(true);
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });

  it("leaves a statement that failed alone", async () => {
    const client = new pg.Client({ connectionString: adminDatabaseUrl });
    await client.connect();
    try {
      const failed = await failureOf(client.query("SELECT * FROM a_table_that_does_not_exist"));

      expect(isDatabaseUnavailableCause(failed)).toBe(false);
    } finally {
      await client.end();
    }
  });
});
