import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/helpers/deferred";
import { required } from "@/test/helpers/required";
import {
  listenForOperationNotifications,
  OPERATION_WAKE_CHANNEL,
  type OperationNotificationListener,
} from "./operation-notifications";

const bindings = { DATABASE_URL: "postgresql://localhost:5432/sdp-notification-test" };
function spies() {
  const clients: Client[] = [];
  const connect = vi.spyOn(Client.prototype, "connect").mockImplementation(function (this: Client) {
    clients.push(this);
    return Promise.resolve();
  });
  const query = vi.spyOn(Client.prototype, "query").mockImplementation(async () => ({
    command: "LISTEN",
    rowCount: null,
    oid: 0,
    fields: [],
    rows: [],
  }));
  const end = vi.spyOn(Client.prototype, "end").mockImplementation(async () => {});
  const wake = vi.fn();
  const connected = vi.fn();
  const failed = vi.fn();
  const tasks: Promise<void>[] = [];
  const options = {
    wake,
    connected,
    failed,
    track: (work: Promise<void>) => {
      tasks.push(work);
    },
  };
  return { clients, connect, query, end, wake, connected, failed, tasks, options };
}

let mocks: ReturnType<typeof spies>;
let listener: OperationNotificationListener | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  mocks = spies();
});
afterEach(async () => {
  await listener?.stop();
  listener = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function start() {
  listener = listenForOperationNotifications(bindings, mocks.options);
  await Promise.all(mocks.tasks);
  return listener;
}

function emit(payload: string, channel = OPERATION_WAKE_CHANNEL) {
  required(mocks.clients.at(-1)).emit("notification", { channel, payload });
}

describe("operation commit notification session", () => {
  it("LISTENs before requesting the startup scan and accepts only environment hints", async () => {
    await start();
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(`LISTEN ${OPERATION_WAKE_CHANNEL}`);
    expect(mocks.connected).toHaveBeenCalledTimes(1);
    emit("sandbox");
    emit("production");
    expect(mocks.wake.mock.calls).toEqual([["sandbox"], ["production"]]);
    emit('{"environment":"sandbox","operationId":"spoof"}');
    emit("sandbox", "unrelated-channel");
    expect(mocks.wake).toHaveBeenCalledTimes(2);
    expect(mocks.failed).toHaveBeenCalledTimes(1);
  });

  it("reconnects and rescans after session failure without trusting missed notifications", async () => {
    await start();
    const first = required(mocks.clients[0]);
    first.emit("error", new Error("Connection lost"));
    first.emit("end");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.connected).toHaveBeenCalledTimes(2);
    first.emit("notification", { channel: OPERATION_WAKE_CHANNEL, payload: "sandbox" });
    expect(mocks.wake).not.toHaveBeenCalled();
    emit("production");
    expect(mocks.wake).toHaveBeenCalledExactlyOnceWith("production");
  });

  it("retries a failed LISTEN session while the scheduled consumer remains independent", async () => {
    mocks.query.mockImplementationOnce(async () => {
      throw new Error("LISTEN failed");
    });
    await start();
    expect(mocks.connected).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.connected).toHaveBeenCalledTimes(1);
  });

  it("stops reconnecting and ignores notifications after shutdown", async () => {
    const current = await start();
    required(mocks.clients[0]).emit("error", new Error("Lost"));
    await current.stop();
    emit("sandbox");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("does not LISTEN or scan if shutdown begins during connection establishment", async () => {
    const connecting = deferred<void>();
    mocks.connect.mockImplementationOnce(function (this: Client) {
      mocks.clients.push(this);
      return connecting.promise;
    });
    listener = listenForOperationNotifications(bindings, mocks.options);
    const stopping = listener.stop();
    connecting.resolve();
    await stopping;
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.connected).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
});
