import { describe, it, expect } from 'vitest';
import { parseWhen, parseAspectAttachment } from '../../../src/io/when-parser.js';

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
      .toThrow(/unknown when operator 'mostly_of'/);
  });

  it('throws on unknown relation type inside relations', () => {
    expect(() => parseWhen({ relations: { invokes: {} } }, 'ctx'))
      .toThrow(/unknown relation type 'invokes'/);
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
      .toThrow(/unknown when operator 'banana'/);
  });
});

describe('parseAspectAttachment', () => {
  it('parses a bare-string aspect id', () => {
    const result = parseAspectAttachment('my-aspect', 'ctx');
    expect(result).toEqual({ id: 'my-aspect' });
  });

  it('trims whitespace around a bare-string id', () => {
    expect(parseAspectAttachment('  trimmed  ', 'ctx')).toEqual({ id: 'trimmed' });
  });

  it('rejects an empty bare string', () => {
    expect(() => parseAspectAttachment('', 'ctx'))
      .toThrow(/aspect id must be a non-empty string/);
  });

  it('rejects a whitespace-only bare string', () => {
    expect(() => parseAspectAttachment('   ', 'ctx'))
      .toThrow(/aspect id must be a non-empty string/);
  });

  it('parses object form with id only', () => {
    expect(parseAspectAttachment({ id: 'my-aspect' }, 'ctx')).toEqual({ id: 'my-aspect' });
  });

  it('parses object form with id and when', () => {
    const result = parseAspectAttachment(
      { id: 'a', when: { node: { type: 'command' } } },
      'ctx',
    );
    expect(result).toEqual({
      id: 'a',
      when: { node: { type: 'command' } },
    });
  });

  it('rejects object form missing id', () => {
    expect(() => parseAspectAttachment({ when: { node: { type: 'x' } } }, 'ctx'))
      .toThrow(/object form requires 'id' as a non-empty string/);
  });

  it('rejects object form with empty id', () => {
    expect(() => parseAspectAttachment({ id: '' }, 'ctx'))
      .toThrow(/object form requires 'id' as a non-empty string/);
  });

  it('rejects object form with unknown field', () => {
    expect(() => parseAspectAttachment({ id: 'a', exceptions: [] }, 'ctx'))
      .toThrow(/unknown field 'exceptions' in aspect attachment/);
  });

  it('rejects arrays', () => {
    expect(() => parseAspectAttachment(['a'], 'ctx'))
      .toThrow(/aspect attachment must be a string or an object/);
  });

  it('rejects numbers', () => {
    expect(() => parseAspectAttachment(42, 'ctx'))
      .toThrow(/aspect attachment must be a string or an object/);
  });

  it('rejects null', () => {
    expect(() => parseAspectAttachment(null, 'ctx'))
      .toThrow(/aspect attachment must be a string or an object/);
  });
});
