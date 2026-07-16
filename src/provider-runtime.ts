export type ProviderRequestOptions = {
  fetch?: typeof fetch;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  requestTimeoutMs?: number;
  random?: () => number;
};

export class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider request timed out after ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

function abortError() {
  const error = new Error("Operation cancelled");
  error.name = "AbortError";
  return error;
}

function retryAfterMs(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(30_000, Math.max(0, date - Date.now()));
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof cause === "string" ? cause : undefined;
}

function retryable(error: unknown) {
  if (error instanceof ProviderHttpError) {
    return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
  }
  if (error instanceof ProviderProtocolError || error instanceof ProviderTimeoutError) return true;
  if (error instanceof TypeError) return true;
  return ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"].includes(errorCode(error) ?? "");
}

function attemptSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function wait(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : abortError());
    function finish(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function responseBody(text: string) {
  const compact = text.trim();
  return compact.length > 4000 ? `${compact.slice(0, 4000)}\n[truncated]` : compact;
}

export async function requestProvider<T>(
  url: string,
  init: RequestInit,
  options: ProviderRequestOptions,
  parentSignal: AbortSignal | undefined,
  parse: (data: unknown) => T,
): Promise<T> {
  const fetchImpl = options.fetch ?? fetch;
  const maxRetries = Math.max(0, Math.min(5, options.maxRetries ?? 2));
  const baseDelay = Math.max(0, options.baseRetryDelayMs ?? 500);
  const timeoutMs = Math.max(10, options.requestTimeoutMs ?? 120_000);
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    parentSignal?.throwIfAborted();
    const scoped = attemptSignal(parentSignal, timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: scoped.signal });
      if (!response.ok) {
        const body = responseBody(await response.text());
        throw new ProviderHttpError(
          response.status,
          `API ${response.status}${body ? `: ${body}` : ""}`,
          retryAfterMs(response.headers.get("retry-after")),
        );
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        throw new ProviderProtocolError(`Provider returned invalid JSON: ${(error as Error).message}`);
      }
      return parse(data);
    } catch (error) {
      if (parentSignal?.aborted) throw abortError();
      const failure = scoped.timedOut() ? new ProviderTimeoutError(timeoutMs) : error;
      if (attempt >= maxRetries || !retryable(failure)) throw failure;
      const serverDelay = failure instanceof ProviderHttpError ? failure.retryAfterMs : undefined;
      const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
      await wait(serverDelay ?? Math.round(baseDelay * 2 ** attempt * jitter), parentSignal);
    } finally {
      scoped.cleanup();
    }
  }
}
