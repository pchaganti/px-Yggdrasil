export interface LlmProvider {
  /** Send self-contained prompt, get verdict */
  verifyAspect(prompt: string): Promise<AspectResponse>;

  /** Check if provider is available (binary on PATH / endpoint reachable) */
  isAvailable(): Promise<boolean>;

  /** Query model context window size. Returns undefined if unknown. */
  getContextWindowSize(): Promise<number | undefined>;
}

export interface AspectResponse {
  aspectId?: string;
  satisfied: boolean;
  reason: string;
  /** Discriminator: codeViolation = real code issue; provider = infra/API error; astRuntime = deterministic check threw (name retained for baseline compat) */
  errorSource: 'codeViolation' | 'provider' | 'astRuntime';
}
