import { describe, it, expect } from 'vitest';
import { KNOWLEDGE_TOPICS } from '../../../src/templates/knowledge/index.js';

describe('KNOWLEDGE_TOPICS', () => {
  it('exports exactly 9 topics', () => {
    expect(Object.keys(KNOWLEDGE_TOPICS).length).toBe(9);
  });

  it('has expected topic names', () => {
    const names = Object.keys(KNOWLEDGE_TOPICS).sort();
    expect(names).toEqual([
      'aspects-overview',
      'cli-reference',
      'conditional-aspects',
      'configuration',
      'drift-and-cascade',
      'suppress-syntax',
      'working-with-architecture',
      'writing-ast-aspects',
      'writing-llm-aspects',
    ]);
  });

  it('each topic has summary and content', () => {
    for (const [, topic] of Object.entries(KNOWLEDGE_TOPICS)) {
      expect(topic.summary).toBeDefined();
      expect(topic.summary.length).toBeGreaterThan(0);
      expect(topic.content).toBeDefined();
      expect(topic.content.length).toBeGreaterThan(50);
    }
  });
});
