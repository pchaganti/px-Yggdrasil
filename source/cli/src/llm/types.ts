export interface LlmProvider {
  /** Send self-contained prompt, get verdict */
  verifyAspect(prompt: string): Promise<AspectResponse>;

  /** Check if provider is available (binary on PATH / endpoint reachable) */
  isAvailable(): Promise<boolean>;
}

export interface AspectResponse {
  aspectId?: string;
  satisfied: boolean;
  reason: string;
  /** Discriminator: codeViolation = real code issue; provider = infra/API error; checkRuntime = deterministic check threw */
  errorSource: 'codeViolation' | 'provider' | 'checkRuntime';
}
