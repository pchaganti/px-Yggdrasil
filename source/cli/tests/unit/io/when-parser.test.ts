import { describe, it, expect } from 'vitest';
import { parseWhen } from '../../../src/io/when-parser.js';

describe('parseWhen', () => {
  it('parses top-level atomic clause (implicit all_of)', () => {
    const raw = { relations: { calls: { target_type: 'service-client' } } };
    const result = parseWhen(raw, 'ctx');
    expect(result).toEqual({
      relations: { calls: { target_type: 'service-client' } },
    });
  });

  it('parses any_of', () => {
    const raw = {
      any_of: [
        { relations: { calls: { target_type: 'a' } } },
        { node: { has_port: 'charge' } },
      ],
    };
    const result = parseWhen(raw, 'ctx');
    expect(result).toEqual(raw);
  });

  it('parses all_of', () => {
    const raw = { all_of: [{ node: { type: 'command' } }] };
    const result = parseWhen(raw, 'ctx');
    expect(result).toEqual(raw);
  });

  it('parses not', () => {
    const raw = { not: { node: { has_mapping: false } } };
    const result = parseWhen(raw, 'ctx');
    expect(result).toEqual(raw);
  });

  it('parses descendants clause', () => {
    const raw = {
      descendants: {
        relations: { calls: { target_type: 'service-client' } },
        type: 'handler',
        has_port: 'subscribe',
      },
    };
    const result = parseWhen(raw, 'ctx');
    expect(result).toEqual(raw);
  });

  it('throws on unknown top-level operator', () => {
    expect(() => parseWhen({ mostly_of: [] }, 'ctx'))
      .toThrow(/Unknown when operator 'mostly_of'/);
  });

  it('throws on unknown relation type inside relations', () => {
    expect(() => parseWhen({ relations: { invokes: {} } }, 'ctx'))
      .toThrow(/Unknown relation type 'invokes'/);
  });

  it('throws when when is not an object', () => {
    expect(() => parseWhen('yes', 'ctx'))
      .toThrow(/must be a YAML mapping/);
  });

  it('throws when all_of is not an array', () => {
    expect(() => parseWhen({ all_of: 'x' }, 'ctx'))
      .toThrow(/'all_of' must be an array/);
  });

  it('throws on unknown atomic clause key', () => {
    expect(() => parseWhen({ banana: {} }, 'ctx'))
      .toThrow(/Unknown when operator 'banana'/);
  });
});
