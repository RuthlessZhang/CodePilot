import type {
  Message,
  Provider,
  ProviderCompletion,
  ProviderCompletionInput,
  ProviderStreamEvent,
  ProviderUsage,
  ToolCall,
  ToolDef,
} from "./types.js";
import {
  ProviderProtocolError,
  readServerSentEvents,
  requestProvider,
  requestProviderStream,
  type ProviderRequestOptions,
} from "./provider-runtime.js";

export type ProviderOptions = ProviderRequestOptions & {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens?: number;
  extraBody?: Record<string, unknown>;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderProtocolError(`Provider response is missing ${label}`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new ProviderProtocolError(`Provider response has invalid ${label}`);
  return value;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compactUsage(usage: ProviderUsage): ProviderUsage | undefined {
  const compact = Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) as ProviderUsage;
  return Object.keys(compact).length ? compact : undefined;
}

function mergeUsage(current: ProviderUsage | undefined, update: ProviderUsage | undefined) {
  if (!update) return current;
  const merged = { ...current };
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) (merged as Record<string, number>)[key] = value;
  }
  if (merged.inputTokens !== undefined && merged.outputTokens !== undefined && update.totalTokens === undefined) {
    merged.totalTokens = merged.inputTokens + merged.outputTokens;
  }
  return merged;
}

function textContent(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    }).join("\n");
  }
  throw new ProviderProtocolError("Provider response has invalid message content");
}

function toolArguments(value: unknown, name: string) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") throw new ProviderProtocolError(`Tool ${name} has invalid arguments`);
  const trimmed = value.trim();
  if (!trimmed) return {};
  const candidates = [trimmed];
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (unfenced !== trimmed) candidates.push(unfenced);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next conservative JSON extraction before failing the response.
    }
  }
  throw new ProviderProtocolError(`Tool ${name} returned malformed JSON arguments`);
}

function openAIUsage(value: unknown): ProviderUsage | undefined {
  const usage = optionalRecord(value);
  if (!usage) return undefined;
  const promptDetails = optionalRecord(usage.prompt_tokens_details);
  const completionDetails = optionalRecord(usage.completion_tokens_details);
  return compactUsage({
    inputTokens: optionalNumber(usage.prompt_tokens),
    outputTokens: optionalNumber(usage.completion_tokens),
    totalTokens: optionalNumber(usage.total_tokens),
    cacheReadInputTokens: optionalNumber(promptDetails?.cached_tokens ?? usage.prompt_cache_hit_tokens),
    reasoningTokens: optionalNumber(completionDetails?.reasoning_tokens),
  });
}

function anthropicUsage(value: unknown): ProviderUsage | undefined {
  const usage = optionalRecord(value);
  if (!usage) return undefined;
  const inputTokens = optionalNumber(usage.input_tokens);
  const outputTokens = optionalNumber(usage.output_tokens);
  return compactUsage({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined,
    cacheReadInputTokens: optionalNumber(usage.cache_read_input_tokens),
    cacheWriteInputTokens: optionalNumber(usage.cache_creation_input_tokens),
  });
}

function parseOpenAIResponse(data: unknown): ProviderCompletion {
  const root = record(data, "response object");
  const choices = root.choices;
  if (!Array.isArray(choices) || !choices.length) throw new ProviderProtocolError("Provider response has no choices");
  const choice = record(choices[0], "choice");
  const message = record(choice.message, "choice message");
  const rawCalls = message.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) throw new ProviderProtocolError("Provider response has invalid tool_calls");
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
  const usage = openAIUsage(root.usage);
  return {
    text: textContent(message.content),
    toolCalls: rawCalls.map((value) => {
      const call = record(value, "tool call");
      const fn = record(call.function, "tool function");
      const name = requiredString(fn.name, "tool name");
      return {
        id: requiredString(call.id, "tool call id"),
        name,
        arguments: toolArguments(fn.arguments, name),
      };
    }),
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}

function parseAnthropicResponse(data: unknown): ProviderCompletion {
  const root = record(data, "response object");
  const content = root.content;
  if (!Array.isArray(content)) throw new ProviderProtocolError("Provider response has invalid content blocks");
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const value of content) {
    const block = record(value, "content block");
    if (block.type === "text") text.push(requiredString(block.text, "text block"));
    if (block.type === "tool_use") {
      const name = requiredString(block.name, "tool name");
      toolCalls.push({
        id: requiredString(block.id, "tool call id"),
        name,
        arguments: toolArguments(block.input, name),
      });
    }
  }
  const finishReason = typeof root.stop_reason === "string" ? root.stop_reason : undefined;
  const usage = anthropicUsage(root.usage);
  return {
    text: text.join("\n"),
    toolCalls,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}

function jsonEvent(data: string) {
  try {
    return record(JSON.parse(data), "stream event");
  } catch (error) {
    if (error instanceof ProviderProtocolError) throw error;
    throw new ProviderProtocolError(`Provider returned invalid stream JSON: ${(error as Error).message}`);
  }
}

async function parseOpenAIStream(response: Response, emit: (event: ProviderStreamEvent) => void): Promise<ProviderCompletion> {
  const text: string[] = [];
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: ProviderUsage | undefined;
  let finishReason: string | undefined;
  let sawChoice = false;
  let done = false;
  await readServerSentEvents(response, ({ data }) => {
    if (data.trim() === "[DONE]") {
      done = true;
      return;
    }
    const root = jsonEvent(data);
    const streamError = optionalRecord(root.error);
    if (streamError) {
      throw new ProviderProtocolError(`Provider stream error${typeof streamError.type === "string" ? ` (${streamError.type})` : ""}: ${typeof streamError.message === "string" ? streamError.message : "unknown error"}`);
    }
    const eventUsage = openAIUsage(root.usage);
    if (eventUsage) usage = eventUsage;
    const choices = root.choices;
    if (!Array.isArray(choices)) throw new ProviderProtocolError("Provider stream event has invalid choices");
    for (const rawChoice of choices) {
      sawChoice = true;
      const choice = record(rawChoice, "stream choice");
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      const delta = optionalRecord(choice.delta);
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        text.push(delta.content);
        emit({ type: "text_delta", text: delta.content });
      }
      if (delta.tool_calls === undefined) continue;
      if (!Array.isArray(delta.tool_calls)) throw new ProviderProtocolError("Provider stream event has invalid tool_calls");
      for (const rawCall of delta.tool_calls) {
        const call = record(rawCall, "stream tool call");
        const index = typeof call.index === "number" && Number.isInteger(call.index) ? call.index : 0;
        const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
        const fn = optionalRecord(call.function);
        const id = typeof call.id === "string" ? call.id : "";
        const name = typeof fn?.name === "string" ? fn.name : "";
        const argumentsDelta = typeof fn?.arguments === "string" ? fn.arguments : "";
        current.id += id;
        current.name += name;
        current.arguments += argumentsDelta;
        calls.set(index, current);
        emit({
          type: "tool_call_delta",
          index,
          ...(id ? { id } : {}),
          ...(name ? { name } : {}),
          ...(argumentsDelta ? { argumentsDelta } : {}),
        });
      }
    }
  });
  if (!done) throw new ProviderProtocolError("Provider stream ended before the [DONE] marker");
  if (!sawChoice) throw new ProviderProtocolError("Provider stream returned no choices");
  const toolCalls = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
    id: requiredString(call.id, "tool call id"),
    name: requiredString(call.name, "tool name"),
    arguments: toolArguments(call.arguments, call.name),
  }));
  if (usage) emit({ type: "usage", usage });
  return {
    text: text.join(""),
    toolCalls,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}

async function parseAnthropicStream(response: Response, emit: (event: ProviderStreamEvent) => void): Promise<ProviderCompletion> {
  const text: string[] = [];
  const calls = new Map<number, { id: string; name: string; arguments: string; input?: Record<string, unknown> }>();
  let usage: ProviderUsage | undefined;
  let finishReason: string | undefined;
  let stopped = false;
  await readServerSentEvents(response, (source) => {
    const root = jsonEvent(source.data);
    const type = typeof root.type === "string" ? root.type : source.event;
    if (type === "error") {
      const error = optionalRecord(root.error);
      throw new ProviderProtocolError(`Anthropic stream error${typeof error?.type === "string" ? ` (${error.type})` : ""}: ${typeof error?.message === "string" ? error.message : "unknown error"}`);
    }
    if (type === "message_start") usage = anthropicUsage(optionalRecord(root.message)?.usage) ?? usage;
    if (type === "message_delta") {
      const eventUsage = anthropicUsage(root.usage);
      usage = mergeUsage(usage, eventUsage);
      const stopReason = optionalRecord(root.delta)?.stop_reason;
      if (typeof stopReason === "string") finishReason = stopReason;
    }
    if (type === "message_stop") stopped = true;
    if (type === "content_block_start") {
      const index = typeof root.index === "number" && Number.isInteger(root.index) ? root.index : 0;
      const block = record(root.content_block, "content block start");
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        text.push(block.text);
        emit({ type: "text_delta", text: block.text });
      }
      if (block.type === "tool_use") {
        const id = requiredString(block.id, "tool call id");
        const name = requiredString(block.name, "tool name");
        calls.set(index, { id, name, arguments: "", input: optionalRecord(block.input) });
        emit({ type: "tool_call_delta", index, id, name });
      }
    }
    if (type === "content_block_delta") {
      const index = typeof root.index === "number" && Number.isInteger(root.index) ? root.index : 0;
      const delta = record(root.delta, "content block delta");
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        text.push(delta.text);
        emit({ type: "text_delta", text: delta.text });
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const call = calls.get(index);
        if (!call) throw new ProviderProtocolError(`Anthropic stream referenced unknown tool block ${index}`);
        call.arguments += delta.partial_json;
        emit({ type: "tool_call_delta", index, argumentsDelta: delta.partial_json });
      }
    }
  });
  if (!stopped) throw new ProviderProtocolError("Anthropic stream ended before message_stop");
  const toolCalls = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments ? toolArguments(call.arguments, call.name) : (call.input ?? {}),
  }));
  if (usage) emit({ type: "usage", usage });
  return {
    text: text.join(""),
    toolCalls,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}

function openAIMessages(system: string, input: ProviderCompletionInput) {
  const messages: unknown[] = [{ role: "system", content: system }];
  for (const message of input.messages) {
    if (message.role === "tool") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
    } else {
      messages.push({
        role: message.role,
        content: message.content || null,
        ...(message.toolCalls?.length ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        } : {}),
      });
    }
  }
  return messages;
}

function openAITools(tools: ToolDef[]) {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

export class OpenAIProvider implements Provider {
  constructor(private options: ProviderOptions) {}

  async complete(input: ProviderCompletionInput) {
    const streaming = Boolean(input.onEvent);
    const request = {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: input.maxOutputTokens ?? this.options.maxOutputTokens ?? 8_192,
        messages: openAIMessages(input.system, input),
        tools: openAITools(input.tools),
        ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
        ...this.options.extraBody,
      }),
    } satisfies RequestInit;
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;
    return streaming
      ? await requestProviderStream(url, request, this.options, input.signal, parseOpenAIStream, input.onEvent!)
      : await requestProvider(url, request, this.options, input.signal, parseOpenAIResponse);
  }
}

export class DeepSeekProvider extends OpenAIProvider {
  constructor(options: ProviderOptions) {
    super({ ...options, extraBody: { temperature: 0, ...options.extraBody } });
  }
}

function anthropicMessages(messages: Message[]) {
  const result: unknown[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      result.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }],
      });
    } else {
      result.push({
        role: message.role,
        content: message.toolCalls?.length
          ? [
              ...(message.content ? [{ type: "text", text: message.content }] : []),
              ...message.toolCalls.map((call) => ({
                type: "tool_use", id: call.id, name: call.name, input: call.arguments,
              })),
            ]
          : message.content,
      });
    }
  }
  return result;
}

export class AnthropicProvider implements Provider {
  constructor(private options: ProviderOptions) {}

  async complete(input: ProviderCompletionInput) {
    const streaming = Boolean(input.onEvent);
    const request = {
      method: "POST",
      headers: {
        "x-api-key": this.options.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: input.maxOutputTokens ?? this.options.maxOutputTokens ?? 8_192,
        system: input.system,
        messages: anthropicMessages(input.messages),
        tools: input.tools.map((tool) => ({
          name: tool.name, description: tool.description, input_schema: tool.inputSchema,
        })),
        ...(streaming ? { stream: true } : {}),
      }),
    } satisfies RequestInit;
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/v1/messages`;
    return streaming
      ? await requestProviderStream(url, request, this.options, input.signal, parseAnthropicStream, input.onEvent!)
      : await requestProvider(url, request, this.options, input.signal, parseAnthropicResponse);
  }
}
