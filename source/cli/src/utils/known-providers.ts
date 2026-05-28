export const KNOWN_PROVIDERS = [
  'ollama', 'openai', 'anthropic', 'google', 'openai-compatible',
  'claude-code', 'codex', 'gemini-cli',
] as const;

export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];
