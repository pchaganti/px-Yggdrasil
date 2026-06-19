import { describe, it, expect } from 'vitest';
import { SCHEMA_TOPICS } from '../../../src/templates/schemas/index.js';

describe('SCHEMA_TOPICS', () => {
  it('exports exactly 5 schemas', () => {
    expect(Object.keys(SCHEMA_TOPICS).length).toBe(5);
  });

  it('has expected schema names (regression pin)', () => {
    const names = Object.keys(SCHEMA_TOPICS).sort();
    expect(names).toEqual(['architecture', 'aspect', 'config', 'flow', 'node']);
  });

  it('each schema has a non-empty summary and YAML-shaped content', () => {
    for (const [slug, topic] of Object.entries(SCHEMA_TOPICS)) {
      expect(topic.summary, slug).toBeDefined();
      expect(topic.summary.length, slug).toBeGreaterThan(10);
      expect(topic.content, slug).toBeDefined();
      expect(topic.content.length, slug).toBeGreaterThan(100);
      expect(topic.content, slug).toMatch(/^# yg-\w+\.yaml/m);
    }
  });

  it('repoints internal cross-references at the command (no schemas/ paths leak through)', () => {
    for (const [slug, topic] of Object.entries(SCHEMA_TOPICS)) {
      expect(topic.content, slug).not.toMatch(/schemas\/yg-/);
    }
  });

  it('normalizes the config version example off the old 5.0.0 literal', () => {
    expect(SCHEMA_TOPICS.config.content).not.toMatch(/version: "5\.0\.0"/);
  });
});
