import { describe, it, expect } from 'vitest';
import { parseFileWhen } from '../../../src/utils/file-when-parser.js';

describe('parseFileWhen', () => {
  describe('atomic clauses', () => {
    it('parses bare path atom', () => {
      const result = parseFileWhen({ path: 'src/**' }, 'test', 'scope.files');
      expect(result).toEqual({ path: 'src/**' });
    });

    it('parses bare content atom', () => {
      const result = parseFileWhen({ content: 'pattern' }, 'test', 'scope.files');
      expect(result).toEqual({ content: 'pattern' });
    });

    it('parses path + content combined as implicit all_of', () => {
      const result = parseFileWhen({ path: 'a', content: 'b' }, 'test', 'scope.files');
      expect(result).toEqual({ path: 'a', content: 'b' });
    });

    it('rejects path that is not a string', () => {
      expect(() => parseFileWhen({ path: 123 }, 'test', 'scope.files')).toThrow(/path must be a string/);
    });

    it('rejects content that is not a string', () => {
      expect(() => parseFileWhen({ content: [] }, 'test', 'scope.files')).toThrow(/content must be a string/);
    });

    it('rejects content with invalid regex', () => {
      expect(() => parseFileWhen({ content: '(unclosed' }, 'test', 'scope.files')).toThrow(/Invalid regex/);
    });
  });

  describe('boolean operators', () => {
    it('parses all_of', () => {
      const result = parseFileWhen({ all_of: [{ path: 'a' }, { content: 'b' }] }, 'test', 'scope.files');
      expect(result).toEqual({ all_of: [{ path: 'a' }, { content: 'b' }] });
    });

    it('parses any_of', () => {
      const result = parseFileWhen({ any_of: [{ path: 'a' }] }, 'test', 'scope.files');
      expect(result).toEqual({ any_of: [{ path: 'a' }] });
    });

    it('parses not', () => {
      const result = parseFileWhen({ not: { path: 'a' } }, 'test', 'scope.files');
      expect(result).toEqual({ not: { path: 'a' } });
    });

    it('parses nested operators', () => {
      const result = parseFileWhen(
        { all_of: [{ path: 'a' }, { not: { content: 'b' } }] },
        'test',
        'scope.files',
      );
      expect(result).toEqual({ all_of: [{ path: 'a' }, { not: { content: 'b' } }] });
    });
  });

  describe('error cases', () => {
    it('rejects empty mapping', () => {
      expect(() => parseFileWhen({}, 'test', 'scope.files')).toThrow(/when mapping must not be empty/);
    });

    it('rejects empty all_of', () => {
      expect(() => parseFileWhen({ all_of: [] }, 'test', 'scope.files')).toThrow(/all_of.*must not be empty/);
    });

    it('rejects empty any_of', () => {
      expect(() => parseFileWhen({ any_of: [] }, 'test', 'scope.files')).toThrow(/any_of.*must not be empty/);
    });

    it('rejects not without body', () => {
      expect(() => parseFileWhen({ not: null }, 'test', 'scope.files')).toThrow(/not.*must be a YAML mapping/);
    });

    it('rejects mixed boolean + atomic at same level', () => {
      expect(() =>
        parseFileWhen({ all_of: [{ path: 'a' }], path: 'b' }, 'test', 'scope.files'),
      ).toThrow(/cannot mix boolean operators with atomic clauses/);
    });

    it('rejects unknown keys', () => {
      expect(() => parseFileWhen({ foo: 'bar' }, 'test', 'scope.files')).toThrow(/unknown.*key.*foo/);
    });
  });
});
