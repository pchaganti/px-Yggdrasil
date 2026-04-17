import { describe, it, expect } from 'vitest';
import type { WhenPredicate } from '../../../src/model/when.js';

describe('WhenPredicate type', () => {
  it('accepts boolean operators and atomic clauses', () => {
    const p: WhenPredicate = {
      any_of: [
        { relations: { calls: { target_type: 'service-client' } } },
        { descendants: { relations: { calls: { target_type: 'service-client' } } } },
      ],
    };
    expect(p).toBeDefined();
  });

  it('accepts top-level atomic clauses (implicit all_of)', () => {
    const p: WhenPredicate = {
      node: { has_port: 'charge' },
    };
    expect(p).toBeDefined();
  });

  it('accepts negation', () => {
    const p: WhenPredicate = {
      not: { relations: { calls: { target_type: 'legacy-client' } } },
    };
    expect(p).toBeDefined();
  });
});
