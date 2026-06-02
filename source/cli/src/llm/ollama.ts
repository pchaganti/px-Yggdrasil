import type { LlmProvider, AspectResponse } from './types.js';
import { debugWrite } from '../utils/debug-log.js';
import { apiFetch } from './api-utils.js';
import { parseAspectResponse } from './cli-base.js';
import type { LlmConfig } from '../model/graph.js';
import { registerProvider } from './provider.js';

export class OllamaProvider implements LlmProvider {
  private endpoint: string;
  private model: string;
  private temperature: number;

  constructor(config: LlmConfig) {
    this.endpoint = config.endpoint ?? 'http://localhost:11434';
    this.model = config.model;
    this.temperature = config.temperature;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await apiFetch(`${this.endpoint}/api/tags`, {}, 'ollama', 5000);
      return res.ok;
    } catch (err) {
      debugWrite(`[ollama] isAvailable: ${(err as Error).message}`);
      return false;
    }
  }

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    const fallback: AspectResponse = { satisfied: false, reason: 'LLM response could not be parsed', errorSource: 'provider' };

    const body = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      think: false,
      options: { temperature: this.temperature, num_predict: 500 },
      format: 'json',
    };

    try {
      const res = await apiFetch(`${this.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 'ollama');
      if (!res.ok) {
        debugWrite(`[ollama] http_error: ${res.status} ${res.statusText}`);
        return fallback;
      }
      const data = await res.json() as { message?: { content?: string } };
      const content = data.message?.content ?? '';
      return parseAspectResponse(content) ?? fallback;
    } catch (err) {
      debugWrite(`[ollama] error: ${(err as Error).message}`);
      return fallback;
    }
  }
}

registerProvider('ollama', (config) => new OllamaProvider(config));
