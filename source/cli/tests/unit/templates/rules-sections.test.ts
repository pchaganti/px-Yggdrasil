import { describe, it, expect } from 'vitest';
import { AGENT_RULES_CONTENT } from '../../../src/templates/rules.js';

describe('AGENT_RULES_CONTENT — required sections', () => {
  const REQUIRED_HEADINGS = [
    '### Working with architecture',
    '### Working with business-language requests',
    '### Per-node artifacts: what they are for',
    '### Log management',
    '### Finding entry points',
    '### Coordinated changes across multiple nodes',
  ];

  for (const h of REQUIRED_HEADINGS) {
    it(`contains heading ${h}`, () => {
      expect(AGENT_RULES_CONTENT).toContain(h);
    });
  }

  const REQUIRED_CLI_TABLE_ROWS = [
    '`yg find',
    '`yg log add',
    '`yg log read',
    '`yg log merge-resolve',
  ];

  for (const row of REQUIRED_CLI_TABLE_ROWS) {
    it(`CLI table mentions ${row}`, () => {
      expect(AGENT_RULES_CONTENT).toContain(row);
    });
  }

  it('mentions log_required default true', () => {
    expect(AGENT_RULES_CONTENT).toMatch(/log_required:.*true.*default|default.*true/);
  });

  it('mentions yg log merge-resolve workflow', () => {
    expect(AGENT_RULES_CONTENT).toMatch(/yg log merge-resolve/);
  });
});
