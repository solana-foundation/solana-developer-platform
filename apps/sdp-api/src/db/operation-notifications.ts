import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { Client } from "pg";
import { z } from "zod";
import { type DatabaseBindings, getConnectionString } from "./client";

/** Notifications carry only an environment hint; the durable operation row authorizes work. */
export const OPERATION_WAKE_CHANNEL = "sdp_operations_due";

interface OperationNotificationOptions {
  wake: (environment: SdpEnvironment) => void;
  connected: () => void;
  disconnected?: () => void;
  failed: (cause: unknown) => void;
  track: (work: Promise<void>) => void;
}

/** A dedicated LISTEN session, independent of request/transaction pooling. */
export interface OperationNotificationListener {
  stop(): Promise<void>;
}

/**
 * Subscribe before scanning the outbox. Reconnection repeats the scan, and scheduled recovery
 * handles missed hints. No notification contains tenant identity or permission to execute.
 */
export function listenForOperationNotifications(
  bindings: DatabaseBindings & { DATABASE_LISTENER_URL?: string | null },
  options: OperationNotificationOptions
): OperationNotificationListener {
  let stopped = false;
  let current: Client | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionWork: Promise<void> = Promise.resolve();
  let reconnectDelay = 1_000;
  const closing = new Set<Promise<void>>();

  function close(client: Client): void {
    const work = client.end().catch(options.failed);
    closing.add(work);
    void work.finally(() => closing.delete(work));
  }

  function disconnected(client: Client, cause: unknown): void {
    if (current !== client) return;
    current = null;
    options.disconnected?.();
    close(client);
    if (stopped) return;
    options.failed(cause);
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startConnection();
    }, reconnectDelay);
    reconnectTimer.unref();
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  }

  async function connect(): Promise<void> {
    const client = new Client({
      connectionString:
        bindings.DATABASE_LISTENER_URL?.trim() ||
        process.env.DATABASE_LISTENER_URL?.trim() ||
        getConnectionString(bindings),
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      application_name: "sdp-operations-notifications",
    });
    current = client;
    client.on("error", (cause) => disconnected(client, cause));
    client.on("end", () => disconnected(client, new Error("Operation notification session ended")));
    client.on("notification", (notification) => {
      if (stopped || current !== client || notification.channel !== OPERATION_WAKE_CHANNEL) return;
      const environment = z.enum(SDP_ENVIRONMENTS).safeParse(notification.payload);
      if (!environment.success) {
        options.failed(new Error("Invalid operation notification environment"));
        return;
      }
      options.wake(environment.data);
    });
    try {
      await client.connect();
      if (stopped || current !== client) return;
      await client.query(`LISTEN ${OPERATION_WAKE_CHANNEL}`);
      if (stopped || current !== client) return;
      reconnectDelay = 1_000;
      options.connected();
    } catch (cause) {
      disconnected(client, cause);
    }
  }

  function startConnection(): void {
    if (stopped) return;
    connectionWork = connect();
    options.track(connectionWork);
  }
  startConnection();

  return {
    async stop() {
      stopped = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const client = current;
      current = null;
      // pg.end() during pg.connect() can leave connect's promise unsettled.
      // Its connection/query deadlines bound this wait; close after it settles.
      await connectionWork;
      if (client !== null) close(client);
      await Promise.allSettled([...closing]);
    },
  };
}
