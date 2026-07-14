export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface RetryDecision {
  retry: boolean;
  reason: string;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 180,
  maxDelayMs: 1_200,
  jitterRatio: 0.25,
};

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || /aborted|cancelled|canceled/i.test(error.message));

export const isTransientStatus = (status: number): boolean =>
  status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

export const shouldRetryProviderFailure = (input: {
  attempt: number;
  maxAttempts: number;
  status?: number;
  error?: unknown;
  validationError?: boolean;
  authError?: boolean;
}): RetryDecision => {
  if (input.attempt >= input.maxAttempts) return { retry: false, reason: "max_attempts" };
  if (input.validationError) return { retry: false, reason: "validation_error" };
  if (input.authError) return { retry: false, reason: "auth_error" };
  if (isAbortError(input.error)) return { retry: false, reason: "cancelled" };
  if (typeof input.status === "number") {
    return isTransientStatus(input.status)
      ? { retry: true, reason: `transient_http_${input.status}` }
      : { retry: false, reason: `permanent_http_${input.status}` };
  }
  if (input.error instanceof Error) {
    return /network|fetch failed|timeout|temporar|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(input.error.message)
      ? { retry: true, reason: "transient_network" }
      : { retry: false, reason: "permanent_error" };
  }
  return { retry: false, reason: "unknown" };
};

export const retryDelayMs = (
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random = Math.random,
): number => {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exponential * policy.jitterRatio * random();
  return Math.round(exponential + jitter);
};

export const waitForRetry = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Request cancelled", "AbortError"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new DOMException("Request cancelled", "AbortError"));
    }, { once: true });
  });

export const withRetry = async <T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    policy?: RetryPolicy;
    signal?: AbortSignal;
    shouldRetryResult?: (result: T, attempt: number) => RetryDecision;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
  } = {},
): Promise<T> => {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = options.sleep ?? waitForRetry;
  let attempt = 1;
  while (true) {
    try {
      const result = await operation(attempt);
      const decision = options.shouldRetryResult?.(result, attempt) ?? { retry: false, reason: "ok" };
      if (!decision.retry) return result;
      await sleep(retryDelayMs(attempt, policy, options.random), options.signal);
    } catch (error) {
      const decision = shouldRetryProviderFailure({ attempt, maxAttempts: policy.maxAttempts, error });
      if (!decision.retry) throw error;
      await sleep(retryDelayMs(attempt, policy, options.random), options.signal);
    }
    attempt += 1;
  }
};
