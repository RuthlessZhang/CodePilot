import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeEventBus, type RuntimeEventName } from "../src/runtime-events.js";
import { ToolRegistry } from "../src/tool-registry.js";
import type { Tool } from "../src/types.js";

function tool(name: string, dispose?: () => Promise<void>): Tool {
  return {
    risk: "read",
    definition: { name, description: `${name} tool`, inputSchema: { type: "object" } },
    async execute() {
      return name;
    },
    dispose,
  };
}

test("ToolRegistry provides deterministic registration, lookup, removal, and disposal", async () => {
  let disposed = 0;
  const first = tool("first", async () => { disposed++; });
  const registry = new ToolRegistry([first]);

  assert.equal(registry.get("first"), first);
  assert.deepEqual(registry.definitions().map((item) => item.name), ["first"]);
  assert.throws(() => registry.register(tool("first")), /already registered/);

  const remove = registry.register(tool("second"));
  assert.deepEqual(registry.list().map((item) => item.definition.name), ["first", "second"]);
  assert.equal(remove(), true);
  assert.equal(registry.has("second"), false);

  await registry.dispose();
  assert.equal(disposed, 1);
});

test("ToolRegistry replaces an owned tool set atomically", () => {
  const first = tool("first");
  const second = tool("second");
  const registry = new ToolRegistry([first, second]);

  assert.throws(() => registry.replace(["first"], [tool("second")]), /already registered/);
  assert.equal(registry.get("first"), first);
  assert.equal(registry.get("second"), second);

  const third = tool("third");
  registry.replace(["first"], [third]);
  assert.equal(registry.has("first"), false);
  assert.equal(registry.get("third"), third);
});

test("RuntimeEventBus emits ordered events and hooks may deny without granting permission", async () => {
  const observed: Array<{ name: RuntimeEventName; sequence: number }> = [];
  const handled: RuntimeEventName[] = [];
  const bus = new RuntimeEventBus({
    onEvent: (event) => observed.push({ name: event.name, sequence: event.sequence }),
    hooks: [{
      name: "protect-generated",
      events: ["edit.preparing"],
      handle(event) {
        handled.push(event.name);
        if (event.name === "edit.preparing" && event.data.args.path === "generated.ts") {
          return { deny: "generated files are protected" };
        }
      },
    }],
  });

  await bus.emit({
    name: "run.started",
    runId: "run-1",
    sessionId: "session-1",
    data: { prompt: "edit", mode: "build" },
  });
  const outcome = await bus.emit({
    name: "edit.preparing",
    runId: "run-1",
    sessionId: "session-1",
    data: { tool: "write_file", args: { path: "generated.ts" } },
  });

  assert.deepEqual(observed, [
    { name: "run.started", sequence: 1 },
    { name: "edit.preparing", sequence: 2 },
  ]);
  assert.deepEqual(handled, ["edit.preparing"]);
  assert.deepEqual(outcome.denied, { hook: "protect-generated", reason: "generated files are protected" });
});

test("RuntimeEventBus isolates hook exceptions and timeouts", async () => {
  const failures: string[] = [];
  const bus = new RuntimeEventBus({
    hookTimeoutMs: 10,
    hooks: [
      { name: "broken", handle() { throw Error("boom"); } },
      { name: "slow", handle: async () => await new Promise<never>(() => {}) },
    ],
    onHookError: ({ hook, error }) => failures.push(`${hook}:${error.name}`),
  });

  const outcome = await bus.emit({
    name: "model.requested",
    runId: "run-2",
    sessionId: "session-2",
    data: { step: 1, messageCount: 1, toolCount: 17 },
  });

  assert.equal(outcome.denied, undefined);
  assert.deepEqual(failures, ["broken:Error", "slow:HookTimeoutError"]);
});

test("RuntimeEventBus propagates caller cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const bus = new RuntimeEventBus();
  await assert.rejects(bus.emit({
    name: "run.started",
    runId: "run-3",
    sessionId: "session-3",
    data: { prompt: "cancelled", mode: "build" },
    signal: controller.signal,
  }), (error: Error) => error.name === "AbortError");
});
