/**
 * Bug-bounty: EXHAUSTIVE coverage of path ownership resolution.
 *
 * Surface under test:
 *   - findOwner (src/cli/owner.ts) — the public ownership resolver. Given a
 *     graph, project root, and a raw file path, it returns which node owns the
 *     file and whether ownership is DIRECT (exact file mapping or glob match) or
 *     INDIRECT (the file is merely under a mapped directory).
 *   - the isOwnedByMapping ownership predicate inside collectTrackedFiles
 *     (src/core/graph/files.ts). It is a private closure built directly on the
 *     shared matcher mappingEntryMatchesFile (src/utils/mapping-path.ts); we
 *     exercise both the matcher in isolation AND its real effect through
 *     collectTrackedFiles (reference files owned by a node's mapping are skipped
 *     from upstream tracking).
 *
 * Properties pinned (from owner.ts + the documented mapping-glob semantics):
 *   - exact plain match => direct:true (and short-circuits the search)
 *   - directory-prefix plain match => direct:false (indirect coverage)
 *   - glob match => direct:true (the pattern names the file explicitly)
 *   - longest-match precedence among competing prefix/glob entries
 *   - first-owner-wins on ties (strict-greater comparison)
 *   - plain exact wins over any glob (early return)
 *   - a file owned by no node => nodePath:null
 *   - `*` does not cross '/', `**` does
 *   - ?, [ ], { } are literal in mapping entries (only `*` triggers glob)
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';
import { findOwner } from '../../../src/cli/owner.js';
import { mappingEntryMatchesFile } from '../../../src/utils/mapping-path.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory graph builders (findOwner does NO disk I/O — it reads graph.nodes).
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = '/workspace/project';

function makeNode(nodePath: string, mapping: string[]): GraphNode {
  return {
    path: nodePath,
    meta: { name: nodePath, type: 'service', mapping },
    children: [],
    parent: null,
  } as GraphNode;
}

/** Build a graph whose nodes preserve declaration order (Map insertion order). */
function makeGraph(nodes: Array<[string, GraphNode]>): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(nodes),
    aspects: [],
    flows: [],
    schemas: [],
    rootPath: `${ROOT}/.yggdrasil`,
  } as unknown as Graph;
}

/** Shorthand: build a one-or-more node graph from [nodePath, mappingPaths] pairs. */
function graphOf(...entries: Array<[string, string[]]>): Graph {
  return makeGraph(entries.map(([p, m]) => [p, makeNode(p, m)] as [string, GraphNode]));
}

// ═════════════════════════════════════════════════════════════════════════════
// findOwner — EXACT MATCH IS DIRECT
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — exact plain match is direct', () => {
  it('exact file mapping returns direct:true', () => {
    const g = graphOf(['svc/v', ['src/core/validator.ts']]);
    const r = findOwner(g, ROOT, 'src/core/validator.ts');
    expect(r.nodePath).toBe('svc/v');
    expect(r.mappingPath).toBe('src/core/validator.ts');
    expect(r.direct).toBe(true);
    expect(r.file).toBe('src/core/validator.ts');
  });

  it('exact match reports the matched file in result.file', () => {
    const g = graphOf(['n', ['a/b/c.ts']]);
    expect(findOwner(g, ROOT, 'a/b/c.ts').file).toBe('a/b/c.ts');
  });

  it('exact match against a single deeply-nested mapped file', () => {
    const g = graphOf(['deep', ['a/b/c/d/e/f.ts']]);
    const r = findOwner(g, ROOT, 'a/b/c/d/e/f.ts');
    expect(r.nodePath).toBe('deep');
    expect(r.direct).toBe(true);
  });

  it('exact match with a trailing slash on the mapping entry (normalized away)', () => {
    // The mapping author wrote a trailing slash; it normalizes to the bare file,
    // so the file still matches exactly and is direct.
    const g = graphOf(['n', ['src/a.ts/']]);
    const r = findOwner(g, ROOT, 'src/a.ts');
    expect(r.nodePath).toBe('n');
    expect(r.mappingPath).toBe('src/a.ts');
    expect(r.direct).toBe(true);
  });

  it('exact match is reported by mappingPath equal to the entry', () => {
    const g = graphOf(['n', ['x/y/z.ts']]);
    expect(findOwner(g, ROOT, 'x/y/z.ts').mappingPath).toBe('x/y/z.ts');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// findOwner — DIRECTORY PREFIX IS INDIRECT (direct:false)
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — directory-prefix match is indirect', () => {
  it('a file inside a mapped directory is indirect (direct:false)', () => {
    const g = graphOf(['svc/core', ['src/core']]);
    const r = findOwner(g, ROOT, 'src/core/validator.ts');
    expect(r.nodePath).toBe('svc/core');
    expect(r.mappingPath).toBe('src/core');
    expect(r.direct).toBe(false);
  });

  it('a deeply-nested file under a mapped directory is still indirect', () => {
    const g = graphOf(['n', ['src']]);
    const r = findOwner(g, ROOT, 'src/a/b/c/deep.ts');
    expect(r.nodePath).toBe('n');
    expect(r.mappingPath).toBe('src');
    expect(r.direct).toBe(false);
  });

  it('a trailing slash on the directory mapping still yields indirect coverage', () => {
    const g = graphOf(['n', ['src/']]);
    const r = findOwner(g, ROOT, 'src/a.ts');
    expect(r.nodePath).toBe('n');
    expect(r.mappingPath).toBe('src');
    expect(r.direct).toBe(false);
  });

  it('the directory entry ITSELF (no trailing path) matches exactly => direct', () => {
    // Querying the directory path exactly equals the mapping entry, which is the
    // plain exact branch — direct:true — NOT the prefix branch.
    const g = graphOf(['n', ['src/core']]);
    const r = findOwner(g, ROOT, 'src/core');
    expect(r.nodePath).toBe('n');
    expect(r.direct).toBe(true);
  });

  it('a sibling-prefix that is not a directory boundary does NOT match', () => {
    // 'src/handle' must not own files under 'src/handlers/...'
    const g = graphOf(['n', ['src/handle']]);
    const r = findOwner(g, ROOT, 'src/handlers/order.ts');
    expect(r.nodePath).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// findOwner — GLOB MATCH TREATED AS DIRECT
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — glob match is treated as direct', () => {
  it('a single-segment * glob match is direct:true', () => {
    const g = graphOf(['n', ['src/*.ts']]);
    const r = findOwner(g, ROOT, 'src/a.ts');
    expect(r.nodePath).toBe('n');
    expect(r.mappingPath).toBe('src/*.ts');
    expect(r.direct).toBe(true);
  });

  it('a suffix glob (*Repository.cs) matches a qualifying file as direct', () => {
    const g = graphOf(['repo', ['src/db/*Repository.cs']]);
    const r = findOwner(g, ROOT, 'src/db/FooRepository.cs');
    expect(r.nodePath).toBe('repo');
    expect(r.direct).toBe(true);
  });

  it('a suffix glob does NOT match a non-qualifying file in the same dir', () => {
    const g = graphOf(['repo', ['src/db/*Repository.cs']]);
    expect(findOwner(g, ROOT, 'src/db/Helper.cs').nodePath).toBeNull();
  });

  it('a ** glob matches files at any depth (direct:true)', () => {
    const g = graphOf(['n', ['src/**/*.ts']]);
    expect(findOwner(g, ROOT, 'src/index.ts').direct).toBe(true);
    const deep = findOwner(g, ROOT, 'src/a/b/c.ts');
    expect(deep.nodePath).toBe('n');
    expect(deep.direct).toBe(true);
  });

  it('a ** glob does not reach into a different root directory', () => {
    const g = graphOf(['n', ['src/**/*.ts']]);
    expect(findOwner(g, ROOT, 'lib/index.ts').nodePath).toBeNull();
  });

  it('a *.ts glob does not match a .js file', () => {
    const g = graphOf(['n', ['src/**/*.ts']]);
    expect(findOwner(g, ROOT, 'src/util.js').nodePath).toBeNull();
  });

  it('a leading-dot segment is matched by ** (dot:true)', () => {
    const g = graphOf(['n', ['src/**/*.ts']]);
    expect(findOwner(g, ROOT, 'src/.hidden/file.ts').nodePath).toBe('n');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// findOwner — SINGLE * DOES NOT CROSS '/', ** DOES
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — glob segment semantics', () => {
  it('* does NOT cross a path separator', () => {
    const g = graphOf(['n', ['src/*.ts']]);
    // src/sub/a.ts has an extra segment; src/*.ts must not match it.
    expect(findOwner(g, ROOT, 'src/sub/a.ts').nodePath).toBeNull();
    // but the flat file matches.
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBe('n');
  });

  it('a bare src/* matches a flat file but not a nested one', () => {
    const g = graphOf(['n', ['src/*']]);
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBe('n');
    expect(findOwner(g, ROOT, 'src/a/b.ts').nodePath).toBeNull();
  });

  it('** crosses separators where * cannot', () => {
    const star = graphOf(['n', ['src/*.ts']]);
    const dstar = graphOf(['n', ['src/**/*.ts']]);
    expect(findOwner(star, ROOT, 'src/a/b.ts').nodePath).toBeNull();
    expect(findOwner(dstar, ROOT, 'src/a/b.ts').nodePath).toBe('n');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// findOwner — LONGEST-MATCH PRECEDENCE
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — longest-match precedence', () => {
  it('the longer of two directory prefixes wins (more specific node)', () => {
    const g = graphOf(['short', ['src']], ['long', ['src/core']]);
    const r = findOwner(g, ROOT, 'src/core/a.ts');
    expect(r.nodePath).toBe('long');
    expect(r.mappingPath).toBe('src/core');
    expect(r.direct).toBe(false);
  });

  it('the longer prefix wins regardless of declaration order (longer first)', () => {
    const g = graphOf(['long', ['src/core']], ['short', ['src']]);
    expect(findOwner(g, ROOT, 'src/core/a.ts').nodePath).toBe('long');
  });

  it('the longer of two globs wins', () => {
    const g = graphOf(['short', ['src/**']], ['long', ['src/**/*.ts']]);
    const r = findOwner(g, ROOT, 'src/a/b.ts');
    expect(r.nodePath).toBe('long');
    expect(r.mappingPath).toBe('src/**/*.ts');
    expect(r.direct).toBe(true);
  });

  it('the longer glob wins even when declared first', () => {
    const g = graphOf(['long', ['src/**/*.ts']], ['short', ['src/**']]);
    expect(findOwner(g, ROOT, 'src/a/b.ts').nodePath).toBe('long');
  });

  it('a longer directory prefix beats a shorter glob (length-only comparison, renders indirect)', () => {
    // dir 's/a/b/c' (len 7) vs glob 's/*.ts' (len 6) — the dir is longer, so it
    // wins and the result is indirect (direct:false) per the prefix branch.
    const g = graphOf(['glob', ['s/*.ts']], ['dir', ['s/a/b/c']]);
    const r = findOwner(g, ROOT, 's/a/b/c/x.ts');
    expect(r.nodePath).toBe('dir');
    expect(r.direct).toBe(false);
  });

  it('a longer glob beats a shorter directory prefix (renders direct)', () => {
    // glob 'src/**/*.ts' (len 11) vs dir 'src' (len 3) — glob wins => direct.
    const g = graphOf(['dir', ['src']], ['glob', ['src/**/*.ts']]);
    const r = findOwner(g, ROOT, 'src/a.ts');
    expect(r.nodePath).toBe('glob');
    expect(r.direct).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// findOwner — FIRST-OWNER-WINS ON TIES (strict-greater comparison)
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — first-owner-wins on equal-length ties', () => {
  it('two equal-length globs: the first-declared node wins', () => {
    const g = graphOf(['g1', ['src/*.ts']], ['g2', ['lib/*.ts', 'src/*.ts']]);
    expect(findOwner(g, ROOT, 'src/x.ts').nodePath).toBe('g1');
  });

  it('reversing declaration order flips the winner for an equal-length tie', () => {
    const g = graphOf(['g2', ['lib/*.ts', 'src/*.ts']], ['g1', ['src/*.ts']]);
    expect(findOwner(g, ROOT, 'src/x.ts').nodePath).toBe('g2');
  });

  it('two equal-length directory prefixes: the first-declared wins', () => {
    const g = graphOf(['a', ['src/aaa']], ['b', ['lib/bbb', 'src/aaa']]);
    const r = findOwner(g, ROOT, 'src/aaa/x.ts');
    expect(r.nodePath).toBe('a');
    expect(r.direct).toBe(false);
  });

  it('a later equal-length match does NOT overwrite the first (strict greater-than)', () => {
    // best is updated only when mappingPath.length > best.length; an equal-length
    // later candidate is ignored.
    const g = graphOf(['a', ['x/*.ts']], ['b', ['y/*.ts', 'z/*.ts']]);
    // x/f.ts only matches node a's glob anyway, but assert the chosen mapping.
    const r = findOwner(g, ROOT, 'x/f.ts');
    expect(r.nodePath).toBe('a');
    expect(r.mappingPath).toBe('x/*.ts');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// findOwner — GLOB vs PLAIN PRECEDENCE (plain exact short-circuits)
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — plain exact wins over glob', () => {
  it('a plain exact match wins over a glob even when the glob node is declared first', () => {
    // The glob is iterated first and provisionally set as best, but the plain
    // exact match returns immediately — exact ownership beats glob ownership.
    const g = graphOf(['glob', ['src/**/*.ts']], ['exact', ['src/a/file.ts']]);
    const r = findOwner(g, ROOT, 'src/a/file.ts');
    expect(r.nodePath).toBe('exact');
    expect(r.mappingPath).toBe('src/a/file.ts');
    expect(r.direct).toBe(true);
  });

  it('a plain exact match wins over a glob when declared first too', () => {
    const g = graphOf(['exact', ['src/a/file.ts']], ['glob', ['src/**/*.ts']]);
    expect(findOwner(g, ROOT, 'src/a/file.ts').nodePath).toBe('exact');
  });

  it('a plain exact match wins over a longer glob (exact beats length)', () => {
    // The glob 'src/**/*.ts' is longer than the exact 'a.ts' entry, yet exact wins.
    const g = graphOf(['glob', ['src/deeply/nested/**/*.ts']], ['exact', ['src/x.ts']]);
    const r = findOwner(g, ROOT, 'src/x.ts');
    expect(r.nodePath).toBe('exact');
    expect(r.direct).toBe(true);
  });

  it('a plain exact wins over a directory prefix that also covers the file', () => {
    const g = graphOf(['dir', ['src']], ['file', ['src/a.ts']]);
    const r = findOwner(g, ROOT, 'src/a.ts');
    expect(r.nodePath).toBe('file');
    expect(r.direct).toBe(true);
  });

  it('when only a glob matches (no exact), the glob owns it directly', () => {
    const g = graphOf(['glob', ['src/*.ts']]);
    const r = findOwner(g, ROOT, 'src/a.ts');
    expect(r.nodePath).toBe('glob');
    expect(r.direct).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// findOwner — FILE OWNED BY NO NODE
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — no owner', () => {
  it('returns nodePath:null when nothing maps the file', () => {
    const g = graphOf(['svc/other', ['src/other/file.ts']]);
    const r = findOwner(g, ROOT, 'src/core/validator.ts');
    expect(r.nodePath).toBeNull();
    expect(r.file).toBe('src/core/validator.ts');
  });

  it('an unowned result carries no mappingPath and no direct flag', () => {
    const g = graphOf(['n', ['lib/a.ts']]);
    const r = findOwner(g, ROOT, 'src/a.ts');
    expect(r.nodePath).toBeNull();
    expect(r.mappingPath).toBeUndefined();
    expect(r.direct).toBeUndefined();
  });

  it('an empty graph (no nodes) returns no owner', () => {
    const g = makeGraph([]);
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBeNull();
  });

  it('a node with an empty mapping owns nothing', () => {
    const g = graphOf(['n', []]);
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBeNull();
  });

  it('blank / whitespace-only mapping entries are filtered out and own nothing', () => {
    const g = graphOf(['n', ['', '   ']]);
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBeNull();
  });

  it('a non-matching glob in a directory leaves a non-qualifying file unowned', () => {
    const g = graphOf(['repo', ['src/*Repository.cs']]);
    expect(findOwner(g, ROOT, 'src/Helper.cs').nodePath).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// findOwner — PATH NORMALIZATION & GUARDS
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — input normalization', () => {
  it('an absolute path inside the project root is normalized to project-relative', () => {
    const g = graphOf(['n', ['src/a.ts']]);
    const r = findOwner(g, ROOT, `${ROOT}/src/a.ts`);
    expect(r.file).toBe('src/a.ts');
    expect(r.nodePath).toBe('n');
    expect(r.direct).toBe(true);
  });

  it('a leading ./ on the query is stripped before matching', () => {
    const g = graphOf(['n', ['src/a.ts']]);
    const r = findOwner(g, ROOT, './src/a.ts');
    expect(r.nodePath).toBe('n');
    expect(r.file).toBe('src/a.ts');
  });

  it('blank / whitespace-only mapping entries are skipped but a valid sibling entry still matches', () => {
    const g = graphOf(['n', ['', '   ', 'src/a.ts']]);
    const r = findOwner(g, ROOT, 'src/a.ts');
    expect(r.nodePath).toBe('n');
    expect(r.direct).toBe(true);
  });

  it('duplicate identical mapping entries on one node resolve to that node', () => {
    const g = graphOf(['n', ['src/a.ts', 'src/a.ts']]);
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBe('n');
  });

  it('throws for an empty path', () => {
    const g = graphOf(['n', ['src/a.ts']]);
    expect(() => findOwner(g, ROOT, '')).toThrow('Path cannot be empty');
  });

  it('throws for a path that escapes the project root', () => {
    const g = graphOf(['n', ['src/a.ts']]);
    expect(() => findOwner(g, ROOT, '../outside.ts')).toThrow('outside project root');
  });

  it('matching is case-sensitive (Src/A.ts does not own src/a.ts)', () => {
    const g = graphOf(['n', ['Src/A.ts']]);
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// findOwner — METACHARACTER LITERALS (only * triggers glob)
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — ?, [ ], { } are literal (only * is a glob)', () => {
  it('a [bracket] segment is a literal directory name (Next.js / SvelteKit route)', () => {
    const g = graphOf(['route', ['app/[id]/page.tsx']]);
    const r = findOwner(g, ROOT, 'app/[id]/page.tsx');
    expect(r.nodePath).toBe('route');
    expect(r.direct).toBe(true);
  });

  it('a [bracket] entry does NOT behave as a character class', () => {
    // If [id] were a char class it would match a single-char segment 'i'.
    const g = graphOf(['route', ['app/[id]/page.tsx']]);
    expect(findOwner(g, ROOT, 'app/i/page.tsx').nodePath).toBeNull();
  });

  it('a ? in a mapping entry is a literal character, not a single-char wildcard', () => {
    const g = graphOf(['n', ['src/a?.ts']]);
    expect(findOwner(g, ROOT, 'src/a?.ts').nodePath).toBe('n'); // literal match
    expect(findOwner(g, ROOT, 'src/ab.ts').nodePath).toBeNull(); // not a wildcard
  });

  it('a { } brace in a mapping entry is literal, not an alternation', () => {
    const g = graphOf(['n', ['src/{a,b}.ts']]);
    expect(findOwner(g, ROOT, 'src/{a,b}.ts').nodePath).toBe('n'); // literal
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBeNull(); // not expanded
  });

  it('once a * is present, accompanying [ ] IS interpreted by the glob engine', () => {
    // Opting into glob via * opts into the rest of minimatch's metachars.
    const g = graphOf(['n', ['src/[ab]*.ts']]);
    expect(findOwner(g, ROOT, 'src/afile.ts').nodePath).toBe('n');
    expect(findOwner(g, ROOT, 'src/cfile.ts').nodePath).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// mappingEntryMatchesFile — the ownership predicate isOwnedByMapping is built on
// (src/core/graph/files.ts uses this verbatim for ownership tests).
// ═════════════════════════════════════════════════════════════════════════════

describe('mappingEntryMatchesFile — ownership predicate (exact / prefix / glob)', () => {
  it('exact file ownership', () => {
    expect(mappingEntryMatchesFile('src/index.ts', 'src/index.ts')).toBe(true);
  });

  it('directory-prefix ownership (child file)', () => {
    expect(mappingEntryMatchesFile('src/handlers', 'src/handlers/order.ts')).toBe(true);
  });

  it('directory-prefix ownership (deeply nested)', () => {
    expect(mappingEntryMatchesFile('src', 'src/a/b/c.ts')).toBe(true);
  });

  it('the directory entry owns itself (exact equality)', () => {
    expect(mappingEntryMatchesFile('src/core', 'src/core')).toBe(true);
  });

  it('non-boundary prefix does NOT confer ownership', () => {
    expect(mappingEntryMatchesFile('src/handle', 'src/handlers/order.ts')).toBe(false);
  });

  it('an unrelated path is not owned', () => {
    expect(mappingEntryMatchesFile('src/handlers', 'lib/util.ts')).toBe(false);
  });

  it('a glob entry owns a qualifying file', () => {
    expect(mappingEntryMatchesFile('src/db/*Repository.cs', 'src/db/FooRepository.cs')).toBe(true);
  });

  it('a glob entry does not own a non-qualifying sibling', () => {
    expect(mappingEntryMatchesFile('src/db/*Repository.cs', 'src/db/Helper.cs')).toBe(false);
  });

  it('* does not cross a separator in ownership', () => {
    expect(mappingEntryMatchesFile('src/*.ts', 'src/sub/a.ts')).toBe(false);
  });

  it('** crosses separators in ownership', () => {
    expect(mappingEntryMatchesFile('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
  });

  it('an empty entry owns nothing', () => {
    expect(mappingEntryMatchesFile('', 'src/a.ts')).toBe(false);
  });

  it('normalizes a leading ./ on both sides', () => {
    expect(mappingEntryMatchesFile('./src/index.ts', 'src/index.ts')).toBe(true);
    expect(mappingEntryMatchesFile('src/index.ts', './src/index.ts')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// isOwnedByMapping (in collectTrackedFiles) — the ownership predicate's REAL
// effect: reference files OWNED by a node's mapping are skipped from upstream
// tracking; non-owned references are tracked. This is the on-disk-agnostic path,
// but we use a fresh temp dir as the project root to honor the FS-hygiene rule.
// ═════════════════════════════════════════════════════════════════════════════

describe('collectTrackedFiles — isOwnedByMapping skips mapping-owned references', () => {
  async function withTempProject(fn: (root: string) => void | Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty-own-'));
    try {
      // Honor the rule that we never touch repo files: do all work under root.
      await mkdir(path.join(root, '.yggdrasil'), { recursive: true });
      await writeFile(path.join(root, '.yggdrasil', '.keep'), '');
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  function llmAspectWithRefs(id: string, refs: string[]): AspectDef {
    return {
      id,
      name: id,
      reviewer: { type: 'llm' },
      artifacts: [{ filename: 'content.md', content: 'rule' }],
      references: refs.map((p) => ({ path: p })),
    } as AspectDef;
  }

  function singleNodeGraph(root: string, aspect: AspectDef, mapping: string[]): { graph: Graph; node: GraphNode } {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'svc', type: 'service', aspects: [aspect.id], mapping },
      children: [],
      parent: null,
    } as GraphNode;
    const graph = {
      config: {
        reviewer: { tiers: { default: { provider: 'ollama', model: 'm', temperature: 0, consensus: 1 } }, default: 'default' },
      },
      architecture: { node_types: { service: { description: 's' } } },
      nodes: new Map([['svc', node]]),
      aspects: [aspect],
      flows: [],
      schemas: [],
      rootPath: path.join(root, '.yggdrasil'),
    } as unknown as Graph;
    return { graph, node };
  }

  it('a reference under a node directory mapping is NOT tracked (owned by SOURCE)', async () => {
    await withTempProject((root) => {
      const aspect = llmAspectWithRefs('a1', ['src/owned/ref.md', 'docs/external.md']);
      const { graph, node } = singleNodeGraph(root, aspect, ['src/owned']);
      const { trackedFiles } = collectTrackedFiles(node, graph);
      const paths = trackedFiles.map((t) => t.path);
      // The mapping-owned reference is skipped (the SOURCE step claims its dir).
      expect(paths).not.toContain('src/owned/ref.md');
      // The external (non-owned) reference IS tracked under the aspects layer.
      expect(paths).toContain('docs/external.md');
      // The directory mapping itself is tracked as a source layer entry.
      expect(paths).toContain('src/owned');
    });
  });

  it('a reference matching an EXACT file mapping is NOT re-tracked as an aspect ref (claimed by SOURCE)', async () => {
    await withTempProject((root) => {
      const aspect = llmAspectWithRefs('a2', ['src/exact.ts', 'docs/note.md']);
      const { graph, node } = singleNodeGraph(root, aspect, ['src/exact.ts']);
      const tracked = collectTrackedFiles(node, graph).trackedFiles;
      // isOwnedByMapping skips the reference loop for an exact-mapped path, so the
      // ONLY entry for it comes from the SOURCE step (layer 'source'), never the
      // aspects layer — no duplicate, and it is tracked as source-drift.
      const entries = tracked.filter((t) => t.path === 'src/exact.ts');
      expect(entries).toHaveLength(1);
      expect(entries[0].layer).toBe('source');
      expect(entries[0].category).toBe('source');
      // A non-owned reference IS tracked under the aspects layer.
      const note = tracked.filter((t) => t.path === 'docs/note.md');
      expect(note).toHaveLength(1);
      expect(note[0].layer).toBe('aspects');
    });
  });

  it('a reference matching a GLOB mapping is treated as owned and skipped', async () => {
    await withTempProject((root) => {
      const aspect = llmAspectWithRefs('a3', ['src/db/CatalogRepository.cs', 'docs/policy.md']);
      const { graph, node } = singleNodeGraph(root, aspect, ['src/db/*Repository.cs']);
      const paths = collectTrackedFiles(node, graph).trackedFiles.map((t) => t.path);
      // The glob mapping owns the reference -> skipped from tracking.
      expect(paths).not.toContain('src/db/CatalogRepository.cs');
      // A reference NOT matching the glob is tracked.
      expect(paths).toContain('docs/policy.md');
    });
  });

  it('a reference that merely shares a non-boundary prefix with the mapping is NOT owned (still tracked)', async () => {
    await withTempProject((root) => {
      // mapping 'src/handle' must not own 'src/handlers/ref.md'.
      const aspect = llmAspectWithRefs('a4', ['src/handlers/ref.md']);
      const { graph, node } = singleNodeGraph(root, aspect, ['src/handle']);
      const paths = collectTrackedFiles(node, graph).trackedFiles.map((t) => t.path);
      expect(paths).toContain('src/handlers/ref.md');
    });
  });
});
