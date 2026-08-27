import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { AgentDriver, AgentDriverBusyError } from "../../src/agent/driver/agent-driver.js";
import type {
  ClaimInboxInput,
  EnqueueInboxInput,
  InboxStorePort,
} from "../../src/core/ports/inbox_store/inbox-store-port.js";
import type { SessionStorePort } from "../../src/core/ports/session_store/session-store-port.js";
import { InMemoryStores } from "../../src/storage/adapters/in_memory/in-memory-stores.js";
import { SqliteStores } from "../../src/storage/adapters/sqlite/sqlite-stores.js";
import { createTempWorkspace, type TempWorkspace } from "../helpers/temp-workspace.js";

type Stores = SessionStorePort & InboxStorePort;
const resources: Array<{ close(): Promise<void> }> = [];
const workspaces: TempWorkspace[] = [];
const options = { signal: new AbortController().signal };
const acceptedAt = "2026-08-27T00:00:00.000Z";
const claimedAt = "2026-08-27T00:01:00.000Z";
const leaseExpiresAt = "2026-08-27T00:02:00.000Z";

class CompleteFailingStores extends InMemoryStores {
  releaseCalls = 0;

  override complete(
    ..._arguments: Parameters<InboxStorePort["complete"]>
  ): ReturnType<InboxStorePort["complete"]> {
    void _arguments;
    return Promise.reject(new Error("complete storage unavailable"));
  }

  override release(
    ...arguments_: Parameters<InboxStorePort["release"]>
  ): ReturnType<InboxStorePort["release"]> {
    this.releaseCalls += 1;
    return super.release(...arguments_);
  }
}

function message(
  itemId = "item-1",
  idempotencyKey = "request-1",
  content = "第一条消息",
): EnqueueInboxInput {
  return {
    schemaVersion: 1,
    itemId,
    sessionId: "session-inbox",
    idempotencyKey,
    acceptedAt,
    message: {
      schemaVersion: 1,
      messageId: `message-${itemId}`,
      role: "user",
      content,
    },
  };
}

function claim(
  claimToken: string,
  claimedBy: string,
  at = claimedAt,
  expiresAt = leaseExpiresAt,
): ClaimInboxInput {
  return {
    schemaVersion: 1,
    sessionId: "session-inbox",
    claim: { claimToken, claimedBy, claimedAt: at, leaseExpiresAt: expiresAt },
  };
}

async function createSession(store: SessionStorePort): Promise<void> {
  await store.create(
    {
      sessionId: "session-inbox",
      recordId: "session-inbox-created",
      createdAt: acceptedAt,
    },
    options,
  );
}

async function inMemory(): Promise<Stores> {
  const store = new InMemoryStores();
  resources.push(store);
  await createSession(store);
  return store;
}

async function sqlite(): Promise<Stores> {
  const workspace = await createTempWorkspace("a2-inbox-");
  workspaces.push(workspace);
  const store = await SqliteStores.open(workspace.resolve("inbox.sqlite"));
  resources.push(store);
  await createSession(store);
  return store;
}

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
});

for (const [name, factory] of [
  ["InMemory", inMemory],
  ["SQLite", sqlite],
] as const) {
  describe(`${name} Inbox contract`, () => {
    it("幂等入队、租约互斥、完成和失败释放都可安全重试", async () => {
      const store = await factory();
      const first = await store.enqueue(message(), options);
      const duplicate = await store.enqueue(message(), options);
      expect(first).toMatchObject({ created: true, item: { sequence: 1, status: "pending" } });
      expect(duplicate).toMatchObject({ created: false, item: { itemId: "item-1" } });
      await expect(
        store.enqueue(message("different-item", "request-1", "内容不同"), options),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await store.enqueue(message("item-2", "request-2", "第二条消息"), options);

      const held = await store.claimNext(claim("claim-a", "worker-a"), options);
      expect(held).toMatchObject({
        itemId: "item-1",
        status: "claimed",
        deliveryAttempt: 1,
      });
      expect(await store.claimNext(claim("claim-a", "worker-a"), options)).toEqual(held);
      expect(
        await store.claimNext(
          claim("claim-b", "worker-b", "2026-08-27T00:01:30.000Z", "2026-08-27T00:02:30.000Z"),
          options,
        ),
      ).toBeNull();
      const renewed = await store.renewClaim(
        {
          schemaVersion: 1,
          sessionId: "session-inbox",
          itemId: "item-1",
          claimToken: "claim-a",
          renewedAt: "2026-08-27T00:01:35.000Z",
          leaseExpiresAt: "2026-08-27T00:03:00.000Z",
        },
        options,
      );
      expect(renewed).toMatchObject({
        status: "claimed",
        lastClaim: { leaseExpiresAt: "2026-08-27T00:03:00.000Z" },
      });
      expect(await store.claimNext(claim("claim-a", "worker-a"), options)).toEqual(renewed);
      expect(
        await store.claimNext(
          claim(
            "claim-after-old-lease",
            "worker-b",
            "2026-08-27T00:02:30.000Z",
            "2026-08-27T00:03:30.000Z",
          ),
          options,
        ),
      ).toBeNull();

      const completionInput = {
        schemaVersion: 1 as const,
        sessionId: "session-inbox",
        itemId: "item-1",
        claimToken: "claim-a",
        completedAt: "2026-08-27T00:02:40.000Z",
        completion: { runId: "run-1", turnId: "turn-1" },
      };
      const completed = await store.complete(completionInput, options);
      expect(completed.status).toBe("completed");
      expect(await store.complete(completionInput, options)).toEqual(completed);

      const second = await store.claimNext(
        claim("claim-c", "worker-c", "2026-08-27T00:03:00.000Z", "2026-08-27T00:04:00.000Z"),
        options,
      );
      expect(second).toMatchObject({ itemId: "item-2", deliveryAttempt: 1 });
      const releaseInput = {
        schemaVersion: 1 as const,
        sessionId: "session-inbox",
        itemId: "item-2",
        claimToken: "claim-c",
        releasedAt: "2026-08-27T00:03:10.000Z",
        failure: { code: "temporary", message: "稍后重试", retryable: true },
      };
      const released = await store.release(releaseInput, options);
      expect(released).toMatchObject({ status: "pending", deliveryAttempt: 1 });
      expect(await store.release(releaseInput, options)).toEqual(released);
      const retried = await store.claimNext(
        claim("claim-d", "worker-d", "2026-08-27T00:03:20.000Z", "2026-08-27T00:04:20.000Z"),
        options,
      );
      expect(retried).toMatchObject({ itemId: "item-2", deliveryAttempt: 2 });

      const page = await store.listInbox("session-inbox", 0, 10, options);
      expect(page.items.map((item) => [item.sequence, item.status])).toEqual([
        [1, "completed"],
        [2, "claimed"],
      ]);
    });
  });
}

it("SQLite 重启后 pending 消息仍在，并把 A1 database schema v2 升级到 v3", async () => {
  const workspace = await createTempWorkspace("a2-inbox-restart-");
  workspaces.push(workspace);
  const databasePath = workspace.resolve("restart.sqlite");
  const first = await SqliteStores.open(databasePath);
  await createSession(first);
  await first.enqueue(message(), options);
  await first.close();

  const simulateA1 = new DatabaseSync(databasePath);
  simulateA1.exec("DROP TABLE inbox_items");
  simulateA1.prepare("UPDATE metadata SET value='2' WHERE key='database_schema_version'").run();
  simulateA1.close();

  const reopened = await SqliteStores.open(databasePath);
  resources.push(reopened);
  // A1 数据库还没有 Inbox，因此先验证升级；随后新入队的数据必须跨下一次重启保留。
  expect((await reopened.listInbox("session-inbox", 0, 10, options)).items).toEqual([]);
  await reopened.enqueue(message(), options);
  await reopened.close();

  const afterRestart = await SqliteStores.open(databasePath);
  resources.push(afterRestart);
  const pending = await afterRestart.claimNext(claim("restart-claim", "restart-worker"), options);
  expect(pending).toMatchObject({ itemId: "item-1", status: "claimed", deliveryAttempt: 1 });
  await afterRestart.close();

  const raw = new DatabaseSync(databasePath, { readOnly: true });
  const version = raw
    .prepare("SELECT value FROM metadata WHERE key='database_schema_version'")
    .get() as Record<string, unknown>;
  raw.close();
  expect(version["value"]).toBe("3");
});

it("两个 SQLite 连接同时领取时，同一 Session 只有一个 active claim", async () => {
  const workspace = await createTempWorkspace("a2-inbox-concurrency-");
  workspaces.push(workspace);
  const databasePath = workspace.resolve("concurrency.sqlite");
  const first = await SqliteStores.open(databasePath);
  const second = await SqliteStores.open(databasePath);
  resources.push(first, second);
  await createSession(first);
  await first.enqueue(message(), options);

  const results = await Promise.all([
    first.claimNext(claim("connection-a", "connection-a"), options),
    second.claimNext(claim("connection-b", "connection-b"), options),
  ]);
  expect(results.filter((item) => item?.status === "claimed")).toHaveLength(1);
  expect(results.filter((item) => item === null)).toHaveLength(1);
});

it("AgentDriver 对重复输入只执行一次，同实例并发明确报 busy", async () => {
  const store = await inMemory();
  let handlerCalls = 0;
  let startHandler!: () => void;
  let finishHandler!: () => void;
  const started = new Promise<void>((resolve) => {
    startHandler = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishHandler = resolve;
  });
  const driver = new AgentDriver({
    inbox: store,
    driverId: "driver-one",
    now: () => new Date("2026-08-27T00:01:00.000Z"),
    claimTokenFactory: () => "driver-claim",
    handler: {
      async handle(item) {
        handlerCalls += 1;
        startHandler();
        await finish;
        return {
          completion: { runId: `run-${item.itemId}`, turnId: `turn-${item.itemId}` },
          value: item.message.content,
        };
      },
    },
  });
  await driver.submit(message(), options);
  await driver.submit(message(), options);
  const running = driver.runNext("session-inbox", options);
  await started;
  await expect(driver.runNext("session-inbox", options)).rejects.toBeInstanceOf(
    AgentDriverBusyError,
  );
  finishHandler();
  await expect(running).resolves.toMatchObject({
    item: { status: "completed", itemId: "item-1" },
    value: "第一条消息",
  });
  expect(handlerCalls).toBe(1);
  expect(await driver.runNext("session-inbox", options)).toBeNull();
});

it("AgentDriver handler 失败会释放消息，下一次领取增加 deliveryAttempt", async () => {
  const store = await inMemory();
  let handlerCalls = 0;
  const claimTokens = ["failed-claim", "retry-claim"];
  const times = [
    "2026-08-27T00:01:00.000Z",
    "2026-08-27T00:01:10.000Z",
    "2026-08-27T00:01:20.000Z",
    "2026-08-27T00:01:30.000Z",
  ];
  const driver = new AgentDriver({
    inbox: store,
    driverId: "retry-driver",
    now: () => new Date(times.shift()!),
    claimTokenFactory: () => claimTokens.shift()!,
    handler: {
      async handle() {
        handlerCalls += 1;
        if (handlerCalls === 1) throw new Error("temporary handler failure");
        return {
          completion: { runId: "retry-run", turnId: "retry-turn" },
          value: "ok",
        };
      },
    },
  });
  await driver.submit(message(), options);
  await expect(driver.runNext("session-inbox", options)).rejects.toThrow(
    "temporary handler failure",
  );
  expect(await store.getItem("item-1", options)).toMatchObject({
    status: "pending",
    deliveryAttempt: 1,
    lastFailure: { code: "Error", retryable: true },
  });
  await expect(driver.runNext("session-inbox", options)).resolves.toMatchObject({
    item: { status: "completed", deliveryAttempt: 2 },
    value: "ok",
  });
});

it("调用方在 handler 内取消后，Driver 仍用独立生命周期信号释放消息", async () => {
  const store = await inMemory();
  const controller = new AbortController();
  const driver = new AgentDriver({
    inbox: store,
    driverId: "cancel-driver",
    now: () => new Date("2026-08-27T00:01:00.000Z"),
    claimTokenFactory: () => "cancel-claim",
    handler: {
      async handle() {
        controller.abort();
        throw new Error("caller cancelled");
      },
    },
  });
  await driver.submit(message(), { signal: controller.signal });

  await expect(driver.runNext("session-inbox", { signal: controller.signal })).rejects.toThrow(
    "caller cancelled",
  );
  expect(await store.getItem("item-1", options)).toMatchObject({
    status: "pending",
    lastFailure: { message: "caller cancelled" },
  });
});

it("handler 成功但 complete 失败时保留 claim，不会 release 并立即重放", async () => {
  const store = new CompleteFailingStores();
  resources.push(store);
  await createSession(store);
  const driver = new AgentDriver({
    inbox: store,
    driverId: "complete-failure-driver",
    now: () => new Date("2026-08-27T00:01:00.000Z"),
    claimTokenFactory: () => "complete-failure-claim",
    handler: {
      async handle() {
        return {
          completion: { runId: "run-complete-failure", turnId: "turn-complete-failure" },
          value: "side effect already happened",
        };
      },
    },
  });
  await driver.submit(message(), options);

  await expect(driver.runNext("session-inbox", options)).rejects.toThrow(
    "complete storage unavailable",
  );
  expect(store.releaseCalls).toBe(0);
  expect(await store.getItem("item-1", options)).toMatchObject({
    status: "claimed",
    lastClaim: { claimToken: "complete-failure-claim" },
  });
});
