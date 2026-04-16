import { describe, it, expect } from 'vitest';
import { AGENT_RULES_CONTENT } from '../../../src/templates/rules.js';

describe('AGENT_RULES_CONTENT', () => {
  it('contains yg-suppress section in guard rails', () => {
    expect(AGENT_RULES_CONTENT).toContain('yg-suppress');
    expect(AGENT_RULES_CONTENT).toContain('Inline Aspect Waiver');
  });

  it('documents the marker format', () => {
    expect(AGENT_RULES_CONTENT).toContain('yg-suppress(<aspect-path>)');
  });

  it('prohibits autonomous suppress usage', () => {
    expect(AGENT_RULES_CONTENT).toContain('NEVER');
    expect(AGENT_RULES_CONTENT).toContain('explicit user confirmation');
  });
});
