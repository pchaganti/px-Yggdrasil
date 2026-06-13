import { describe, it, expect } from 'vitest';
import { relationRefusedMessage, relationUnverifiedMessage } from '../../../src/relations/messages.js';

describe('relation messages', () => {
  it('relationRefusedMessage embeds the violation reason in the what block', () => {
    const m = relationRefusedMessage('a', 'src/a/foo.ts:1 → undeclared dependency on b');
    expect(m.what).toContain("Node 'a' has undeclared dependencies");
    expect(m.what).toContain('src/a/foo.ts:1 → undeclared dependency on b');
    expect(m.why).toContain('sanctioned, declared relation');
    expect(m.next).toContain("yg-node.yaml");
  });

  it('relationRefusedMessage tolerates a missing reason (trims trailing colon block)', () => {
    const m = relationRefusedMessage('a', undefined);
    expect(m.what).toContain("Node 'a' has undeclared dependencies");
    // No dangling trailing newline when the reason is absent.
    expect(m.what.endsWith(':')).toBe(true);
  });

  it('relationUnverifiedMessage points at yg check --approve', () => {
    const m = relationUnverifiedMessage('a');
    expect(m.what).toContain("node 'a' is unverified");
    expect(m.next).toContain('yg check --approve');
  });
});
