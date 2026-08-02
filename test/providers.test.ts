import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider, DeepSeekProvider, OpenAIProvider } from "../src/providers.js";
import type { ProviderStreamEvent } from "../src/types.js";

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

function eventStream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
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

  await new OpenAIProvider(options(fetchImpl, { maxOutputTokens: 1_234 })).complete({ ...input, maxOutputTokens: 321 });
  assert.equal(bodies[1]?.max_tokens, 321);
});

test("applies per-request output budgets across DeepSeek and Anthropic adapters", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const openAIFetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return json(openAIMessage());
  }) as typeof fetch;
  const anthropicFetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return json({ content: [] });
  }) as typeof fetch;

  await new DeepSeekProvider(options(openAIFetch)).complete({ ...input, maxOutputTokens: 456 });
  await new AnthropicProvider(options(anthropicFetch)).complete({ ...input, maxOutputTokens: 789 });

  assert.equal(bodies[0]?.max_tokens, 456);
  assert.equal(bodies[0]?.temperature, 0);
  assert.equal(bodies[1]?.max_tokens, 789);
});

test("streams OpenAI-compatible text, indexed tool arguments, and final usage", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return eventStream([
      'data: {"choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}\r',
      '\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16,"prompt_tokens_details":{"cached_tokens":7},"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
      'data: [DONE]\n\n',
    ]);
  }) as typeof fetch;
  const events: ProviderStreamEvent[] = [];

  const result = await new OpenAIProvider(options(fetchImpl)).complete({ ...input, onEvent: (event) => events.push(event) });

  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(result.text, "hello");
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.toolCalls, [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }]);
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
    cacheReadInputTokens: 7,
    reasoningTokens: 2,
  });
  assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.text : "").join(""), "hello");
  assert.deepEqual(events.at(-1), { type: "usage", usage: result.usage });
});

test("streams Anthropic content blocks, partial tool JSON, and cumulative usage", async () => {
  const fetchImpl = (async () => eventStream([
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":6,"cache_creation_input_tokens":2}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"inspect"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"read_file","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"src/app.ts\\"}"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ])) as typeof fetch;
  const events: ProviderStreamEvent[] = [];

  const result = await new AnthropicProvider(options(fetchImpl)).complete({ ...input, onEvent: (event) => events.push(event) });

  assert.equal(result.text, "inspect");
  assert.equal(result.finishReason, "tool_use");
  assert.deepEqual(result.toolCalls, [{ id: "tool-1", name: "read_file", arguments: { path: "src/app.ts" } }]);
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cacheReadInputTokens: 6,
    cacheWriteInputTokens: 2,
  });
  assert.deepEqual(events.at(-1), { type: "usage", usage: result.usage });
});

test("does not retry a stream after semantic output was emitted", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return eventStream([
      'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      'data: {invalid}\n\n',
    ]);
  }) as typeof fetch;

  await assert.rejects(
    new OpenAIProvider(options(fetchImpl)).complete({ ...input, onEvent() {} }),
    /invalid stream JSON/,
  );
  assert.equal(calls, 1);
});

test("retries a malformed stream before its first semantic event", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return calls === 1
      ? eventStream(['data: {invalid}\n\n'])
      : eventStream([
          'data: {"choices":[{"index":0,"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]);
  }) as typeof fetch;

  const result = await new OpenAIProvider(options(fetchImpl)).complete({ ...input, onEvent() {} });
  assert.equal(calls, 2);
  assert.equal(result.text, "recovered");
});

test("rejects an interrupted stream instead of accepting a partial completion", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return eventStream(['data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n']);
  }) as typeof fetch;

  await assert.rejects(
    new OpenAIProvider(options(fetchImpl)).complete({ ...input, onEvent() {} }),
    /before the \[DONE\] marker/,
  );
  assert.equal(calls, 1);
});

test("parses non-stream provider usage without requiring streaming", async () => {
  const fetchImpl = (async () => json({
    ...openAIMessage(),
    usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, prompt_cache_hit_tokens: 8 },
  })) as typeof fetch;

  const result = await new OpenAIProvider(options(fetchImpl)).complete(input);
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 3, totalTokens: 23, cacheReadInputTokens: 8 });
});
