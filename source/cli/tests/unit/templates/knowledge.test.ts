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

  const REQUIRED_HEADINGS: Record<string, string[]> = {
    'working-with-architecture': [
      '## Type kinds',
      '## Predicate grammar',
      '## When to use enforce: strict',
      '## Defending against cross-file evasion',
      '## Pitfalls',
    ],
    'aspects-overview': [
      '## LLM vs AST',
      '## When to use LLM',
      '## When to use AST',
      '## Decision tree',
    ],
    'writing-llm-aspects': [
      '## content.md format',
      '## Writing the rules',
      '## Cost considerations',
      '## False-positive mitigation',
    ],
    'writing-ast-aspects': [
      '## check.mjs structure',
      '## The twelve helpers',
      '## Purity rule',
      '## Testing with yg ast-test',
    ],
    'conditional-aspects': [
      '## Aspect-level when grammar',
      '## Applicability examples',
      '## Propagation through channels',
    ],
    'suppress-syntax': ['## Single-line', '## Bracket', '## Wildcard', '## When to suppress'],
    'drift-and-cascade': ['## Source drift', '## Upstream drift', '## Cascade scope', '## Cost'],
    configuration: [
      '## yg-config.yaml reference',
      '## Provider configs',
      '## Secrets',
      '## Quality thresholds',
    ],
    'cli-reference': [
      '## yg check',
      '## yg approve',
      '## yg context',
      '## yg impact',
      '## yg type-suggest',
      '## yg knowledge',
    ],
  };

  it('each topic contains all required H2 headings', () => {
    for (const [name, headings] of Object.entries(REQUIRED_HEADINGS)) {
      const content = KNOWLEDGE_TOPICS[name].content;
      for (const h of headings) {
        expect(content, `${name} missing heading "${h}"`).toMatch(
          new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm'),
        );
      }
    }
  });

  it('each topic content is at least 1500 chars', () => {
    for (const [name, topic] of Object.entries(KNOWLEDGE_TOPICS)) {
      expect(topic.content.length, `${name} content too short`).toBeGreaterThan(1500);
    }
  });
});
