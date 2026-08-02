import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider, OpenAIProvider } from "../src/providers.js";

const input = { system: "Be careful", messages: [], tools: [] };

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function openAIMessage(content = "done") {
  return { choices: [{ message: { content, tool_calls: [] } }] };
}

function options(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return {
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    model: "test-model",
    fetch: fetchImpl,
    baseRetryDelayMs: 0,
    random: () => 0,
    ...overrides,
  };
}

test("retries a rate-limited OpenAI-compatible request and honors Retry-After", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    return json(openAIMessage("recovered"));
  }) as typeof fetch;

  const result = await new OpenAIProvider(options(fetchImpl)).complete(input);
  assert.equal(calls, 2);
  assert.equal(result.text, "recovered");
});

test("does not retry a non-transient provider error", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("invalid request", { status: 400 });
  }) as typeof fetch;

  await assert.rejects(new OpenAIProvider(options(fetchImpl)).complete(input), /API 400: invalid request/);
  assert.equal(calls, 1);
});

test("retries a malformed tool call response and parses conservative JSON fences", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    const argumentsText = calls === 1 ? "{bad" : '```json\n{"path":"src/app.ts"}\n```';
    return json({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: argumentsText } }],
        },
      }],
    });
  }) as typeof fetch;

  const result = await new OpenAIProvider(options(fetchImpl)).complete(input);
  assert.equal(calls, 2);
  assert.deepEqual(result.toolCalls[0]?.arguments, { path: "src/app.ts" });
});

test("retries a timed-out request with a fresh attempt signal", async () => {
  let calls = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls++;
    if (calls > 1) return json(openAIMessage("after timeout"));
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("request aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  }) as typeof fetch;

  const result = await new OpenAIProvider(options(fetchImpl, { requestTimeoutMs: 20 })).complete(input);
  assert.equal(calls, 2);
  assert.equal(result.text, "after timeout");
});

test("cancels retry backoff without starting another request", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  const controller = new AbortController();
  const pending = new OpenAIProvider(options(fetchImpl, { baseRetryDelayMs: 10_000 })).complete({ ...input, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  assert.equal(calls, 1);
});

test("validates and parses Anthropic content blocks", async () => {
  const fetchImpl = (async () => json({
    content: [
      { type: "text", text: "inspect" },
      { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "README.md" } },
    ],
  })) as typeof fetch;

  const result = await new AnthropicProvider(options(fetchImpl)).complete(input);
  assert.equal(result.text, "inspect");
  assert.deepEqual(result.toolCalls, [{ id: "tool-1", name: "read_file", arguments: { path: "README.md" } }]);
});

test("sends the configured output limit to provider APIs", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return json(openAIMessage());
  }) as typeof fetch;
  await new OpenAIProvider(options(fetchImpl, { maxOutputTokens: 1_234 })).complete(input);
  assert.equal(bodies[0]?.max_tokens, 1_234);
});
