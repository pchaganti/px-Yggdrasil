import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { makeResolvePathToFile } from '../../../../src/relations/resolve-path.js';

// Ruby's `require_relative '<lit>'` resolves relative to the requiring file's directory,
// `.rb` appended. These tests build a real temp tree and drive the production
// makeResolvePathToFile (disk-backed existence) through the `ruby` branch.

describe('resolveRubyRequireRelative via makeResolvePathToFile (disk-backed)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ruby-resolve-'));
    mkdirSync(path.join(root, 'app', 'services'), { recursive: true });
    mkdirSync(path.join(root, 'app', 'models'), { recursive: true });
    writeFileSync(path.join(root, 'app', 'services', 'order_service.rb'), '# order\n', 'utf-8');
    writeFileSync(path.join(root, 'app', 'models', 'helper.rb'), '# helper\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a sibling require_relative './helper'", () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('./helper', 'app/models/order.rb', 'ruby')).toBe('app/models/helper.rb');
  });

  it('resolves a bare relative name (no leading ./) appending .rb', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('helper', 'app/models/order.rb', 'ruby')).toBe('app/models/helper.rb');
  });

  it("resolves a parent-directory require_relative '../services/order_service'", () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../services/order_service', 'app/models/order.rb', 'ruby')).toBe(
      'app/services/order_service.rb',
    );
  });

  it('honors an explicit .rb extension without doubling it', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('./helper.rb', 'app/models/order.rb', 'ruby')).toBe('app/models/helper.rb');
  });

  it('MISS → undefined for a non-existent target (silence)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('./nonexistent', 'app/models/order.rb', 'ruby')).toBeUndefined();
  });

  it('MISS → undefined when the relative path escapes the repo root', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../../../etc/passwd', 'app/models/order.rb', 'ruby')).toBeUndefined();
  });
});
