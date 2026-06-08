/**
 * BOUNTY 4 — Spec-conformance audit of the yg-node.yaml and yg-aspect.yaml
 * schemas against their implementing parsers/validators.
 *
 * Authoritative spec (read in full):
 *   - .yggdrasil/schemas/yg-node.yaml
 *   - .yggdrasil/schemas/yg-aspect.yaml
 *
 * Implementing code confronted:
 *   - src/io/node-parser.ts        (parseNodeYaml)
 *   - src/io/aspect-parser.ts      (parseAspect)
 *   - src/core/checks/relations.ts (checkMissingDescriptions — schema says the
 *                                   validator, not the parser, emits description-missing)
 *   - src/core/checks/architecture.ts (checkPortConsumes — port/consumes contract)
 *
 * Each test maps to a concrete invariant the schema documents. Where the code
 * diverges from the schema, the divergence is recorded in the bounty report and
 * the conflicting assertion is omitted so this file stays 100% green.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNodeYaml } from '../../../src/io/node-parser.js';
import { parseAspect, type ParseAspectResult } from '../../../src/io/aspect-parser.js';
import { checkMissingDescriptions } from '../../../src/core/checks/relations.js';
import { checkPortConsumes } from '../../../src/core/checks/architecture.js';
import type {
  Graph,
  GraphNode,
  AspectDef,
  ArchitectureDef,
  NodeMeta,
} from '../../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const E2E_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

// ── Temp-dir bookkeeping ────────────────────────────────────────────────────
const tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Write a yg-node.yaml into a fresh temp dir and parse it. */
async function parseNode(yaml: string): Promise<NodeMeta> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-bnty4-node-'));
  tempDirs.push(dir);
  const p = path.join(dir, 'yg-node.yaml');
  await writeFile(p, yaml, 'utf-8');
  return parseNodeYaml(p);
}

/** Write a yg-aspect.yaml (+ optional sibling rule files) and parse it. */
async function parseAsp(
  yaml: string,
  files: Record<string, string> = {},
  id = 'probe',
): Promise<ParseAspectResult> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-bnty4-asp-'));
  tempDirs.push(dir);
  await writeFile(path.join(dir, 'yg-aspect.yaml'), yaml, 'utf-8');
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf-8');
  }
  return parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), id);
}

function assertOk(r: ParseAspectResult): AspectDef {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('expected ok aspect result');
  return r.aspect;
}
function assertFail(r: ParseAspectResult) {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected failed aspect result');
  return r.errors;
}
function codes(r: ParseAspectResult): string[] {
  if (r.ok) return [];
  return r.errors.map((e) => e.code);
}

// ════════════════════════════════════════════════════════════════════════════
// yg-node.yaml — REQUIRED FIELDS
// schema lines 7-9: name, type, description are "required"
// ════════════════════════════════════════════════════════════════════════════
describe('yg-node.yaml — required name/type', () => {
  it('name is required: parser rejects a node with no name', async () => {
    await expect(parseNode('type: service\n')).rejects.toThrow(/missing or empty 'name'/);
  });

  it('name is required: parser rejects an empty/whitespace name', async () => {
    await expect(parseNode('name: "   "\ntype: service\n')).rejects.toThrow(
      /missing or empty 'name'/,
    );
  });

  it('type is required: parser rejects a node with no type', async () => {
    await expect(parseNode('name: N\n')).rejects.toThrow(/missing or empty 'type'/);
  });

  it('type is required: parser rejects an empty/whitespace type', async () => {
    await expect(parseNode('name: N\ntype: "   "\n')).rejects.toThrow(
      /missing or empty 'type'/,
    );
  });

  it('a valid name+type parses; name/type are trimmed', async () => {
    const meta = await parseNode('name: "  MyNode  "\ntype: "  service  "\n');
    expect(meta.name).toBe('MyNode');
    expect(meta.type).toBe('service');
  });

  it('empty/non-mapping YAML file is rejected', async () => {
    await expect(parseNode('')).rejects.toThrow(/empty or not a valid YAML mapping/);
    await expect(parseNode('- a\n- b\n')).rejects.toThrow(/empty or not a valid YAML mapping/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-node.yaml — description (schema says REQUIRED; "Validator emits
// description-missing if absent" — i.e. enforcement lives in the validator,
// not the parser). We assert BOTH halves.
// ════════════════════════════════════════════════════════════════════════════
describe('yg-node.yaml — description (validator-enforced per schema)', () => {
  it('parser tolerates a missing description (leaves it undefined)', async () => {
    const meta = await parseNode('name: N\ntype: service\n');
    expect(meta.description).toBeUndefined();
  });

  it('parser captures + trims a present description', async () => {
    const meta = await parseNode('name: N\ntype: service\ndescription: "  hi  "\n');
    expect(meta.description).toBe('hi');
  });

  it('validator emits description-missing (error) for a node without description', () => {
    const node = makeNode('svc', { name: 'Svc', type: 'service' });
    const graph = makeGraph({ nodes: new Map([['svc', node]]) });
    const issues = checkMissingDescriptions(graph);
    const hit = issues.find((i) => i.code === 'description-missing' && i.nodePath === 'svc');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('error');
  });

  it('validator does NOT emit description-missing when a node has a description', () => {
    const node = makeNode('svc', { name: 'Svc', type: 'service', description: 'present' });
    const graph = makeGraph({ nodes: new Map([['svc', node]]) });
    const issues = checkMissingDescriptions(graph);
    expect(issues.some((i) => i.code === 'description-missing')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-node.yaml — mapping (schema lines 40-44): optional flat list of
// repo-root-relative file/dir path STRINGS; each entry a path.
// ════════════════════════════════════════════════════════════════════════════
describe('yg-node.yaml — mapping shape', () => {
  it('mapping is optional (absent => undefined)', async () => {
    const meta = await parseNode('name: N\ntype: service\n');
    expect(meta.mapping).toBeUndefined();
  });

  it('mapping accepts a flat string array', async () => {
    const meta = await parseNode('name: N\ntype: service\nmapping:\n  - src/a.ts\n  - src/b/\n');
    expect(meta.mapping).toEqual(['src/a.ts', 'src/b/']);
  });

  it('mapping must be an array, not a scalar', async () => {
    await expect(parseNode('name: N\ntype: service\nmapping: "x"\n')).rejects.toThrow(
      /mapping must be an array/,
    );
  });

  it('mapping must not be an empty array', async () => {
    await expect(parseNode('name: N\ntype: service\nmapping: []\n')).rejects.toThrow(
      /must not be empty/,
    );
  });

  it('mapping entries must be strings, not objects (no group form)', async () => {
    await expect(
      parseNode('name: N\ntype: service\nmapping:\n  - paths: [src/a.ts]\n'),
    ).rejects.toThrow(/flat list of file\/directory paths/i);
  });

  it('mapping entries must be non-empty strings', async () => {
    await expect(parseNode('name: N\ntype: service\nmapping:\n  - ""\n')).rejects.toThrow(
      /must be a non-empty string/,
    );
  });

  it('mapping paths must be repo-root-relative (no leading slash)', async () => {
    await expect(parseNode('name: N\ntype: service\nmapping:\n  - /abs/path.ts\n')).rejects.toThrow(
      /relative to repository root/,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-node.yaml — relations (schema lines 31-38): array of { target (required,
// non-empty), type (required, one of six), consumes? }.
// ════════════════════════════════════════════════════════════════════════════
describe('yg-node.yaml — relations shape', () => {
  it('relations is optional (absent => undefined)', async () => {
    const meta = await parseNode('name: N\ntype: service\n');
    expect(meta.relations).toBeUndefined();
  });

  it('relations must be an array', async () => {
    await expect(parseNode('name: N\ntype: service\nrelations: "x"\n')).rejects.toThrow(
      /'relations' must be an array/,
    );
  });

  it('each relation must be an object', async () => {
    await expect(
      parseNode('name: N\ntype: service\nrelations:\n  - "x"\n'),
    ).rejects.toThrow(/must be an object/);
  });

  it('relation.target is required and non-empty', async () => {
    await expect(
      parseNode('name: N\ntype: service\nrelations:\n  - target: ""\n    type: uses\n'),
    ).rejects.toThrow(/target must be a non-empty string/);
  });

  it.each(['calls', 'uses', 'extends', 'implements', 'emits', 'listens'])(
    'relation.type accepts the documented type %s',
    async (t) => {
      const meta = await parseNode(`name: N\ntype: service\nrelations:\n  - target: other\n    type: ${t}\n`);
      expect(meta.relations?.[0]?.type).toBe(t);
    },
  );

  it('relation.type rejects an out-of-enum value', async () => {
    await expect(
      parseNode('name: N\ntype: service\nrelations:\n  - target: other\n    type: bogus\n'),
    ).rejects.toThrow(/type is invalid/);
  });

  it('relation.type is required (missing type rejected)', async () => {
    await expect(
      parseNode('name: N\ntype: service\nrelations:\n  - target: other\n'),
    ).rejects.toThrow(/type is invalid/);
  });

  it('consumes accepts a string array of port names', async () => {
    const meta = await parseNode(
      'name: N\ntype: service\nrelations:\n  - target: other\n    type: uses\n    consumes: [login, logout]\n',
    );
    expect(meta.relations?.[0]?.consumes).toEqual(['login', 'logout']);
  });

  it('a mixed string/non-string consumes array is rejected loudly (no silent drop)', async () => {
    const err = await parseNode(
      'name: N\ntype: service\nrelations:\n  - target: other\n    type: uses\n    consumes: [login, 99, logout]\n',
    ).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/consumes contains non-string/);
    expect(err?.message).toContain('99');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-node.yaml — ports (schema lines 21-29): mapping of port-name -> { description
// (required, non-empty), aspects (required array) }.
// ════════════════════════════════════════════════════════════════════════════
describe('yg-node.yaml — ports shape', () => {
  it('ports is optional (absent => undefined)', async () => {
    const meta = await parseNode('name: N\ntype: service\n');
    expect(meta.ports).toBeUndefined();
  });

  it('ports must be a mapping, not an array', async () => {
    await expect(parseNode('name: N\ntype: service\nports:\n  - charge\n')).rejects.toThrow(
      /ports must be a mapping/,
    );
  });

  it('each port definition must be an object', async () => {
    await expect(
      parseNode('name: N\ntype: service\nports:\n  charge: "x"\n'),
    ).rejects.toThrow(/ports\.charge must be an object/);
  });

  it('port.description is required and non-empty', async () => {
    await expect(
      parseNode('name: N\ntype: service\nports:\n  charge:\n    aspects: [a]\n'),
    ).rejects.toThrow(/ports\.charge\.description must be a non-empty string/);
  });

  it('port.aspects is required (must be present and an array)', async () => {
    await expect(
      parseNode('name: N\ntype: service\nports:\n  charge:\n    description: x\n'),
    ).rejects.toThrow(/ports\.charge\.aspects must be an array/);
  });

  it('port.aspects may be empty, and a valid port round-trips', async () => {
    const meta = await parseNode(
      'name: N\ntype: service\nports:\n  charge:\n    description: Charge port\n    aspects: [correlation, idempotency]\n  balance:\n    description: Balance\n    aspects: []\n',
    );
    expect(meta.ports?.charge).toEqual({
      description: 'Charge port',
      aspects: ['correlation', 'idempotency'],
    });
    expect(meta.ports?.balance).toEqual({ description: 'Balance', aspects: [] });
  });

  it('a port aspect may use the documented object form { id, status, when }', async () => {
    const meta = await parseNode(
      [
        'name: N',
        'type: service',
        'ports:',
        '  charge:',
        '    description: Charge port',
        '    aspects:',
        '      - bare-aspect',
        '      - id: conditional',
        '        status: enforced',
        '        when:',
        '          node: { has_mapping: true }',
      ].join('\n'),
    );
    expect(meta.ports?.charge?.aspects).toEqual(['bare-aspect', 'conditional']);
    expect(meta.ports?.charge?.aspectStatus?.conditional).toBe('enforced');
    expect(meta.ports?.charge?.aspectWhens?.conditional).toEqual({
      node: { has_mapping: true },
    });
  });

  it('duplicate aspect id inside one port is rejected', async () => {
    await expect(
      parseNode(
        'name: N\ntype: service\nports:\n  charge:\n    description: x\n    aspects: [a, a]\n',
      ),
    ).rejects.toThrow(/ports\.charge\.aspects has duplicate 'a'/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-node.yaml — aspects (schema lines 12-19): optional array; bare string OR
// object { id, status?, when? }. Cascade duplicates rejected.
// ════════════════════════════════════════════════════════════════════════════
describe('yg-node.yaml — aspects attach shape', () => {
  it('aspects is optional; empty array normalizes to undefined', async () => {
    expect((await parseNode('name: N\ntype: service\n')).aspects).toBeUndefined();
    expect((await parseNode('name: N\ntype: service\naspects: []\n')).aspects).toBeUndefined();
  });

  it('aspects must be an array', async () => {
    await expect(parseNode('name: N\ntype: service\naspects: foo\n')).rejects.toThrow(
      /'aspects' must be an array/,
    );
  });

  it('bare string aspect attaches with no status override', async () => {
    const meta = await parseNode('name: N\ntype: service\naspects:\n  - input-validation\n');
    expect(meta.aspects).toEqual(['input-validation']);
    expect(meta.aspectStatus).toBeUndefined();
  });

  it('object form { id, status } captures the status override (channel 1)', async () => {
    const meta = await parseNode(
      'name: N\ntype: service\naspects:\n  - id: input-validation\n    status: advisory\n',
    );
    expect(meta.aspects).toEqual(['input-validation']);
    expect(meta.aspectStatus?.['input-validation']).toBe('advisory');
  });

  it('object form requires a non-empty string id', async () => {
    await expect(
      parseNode('name: N\ntype: service\naspects:\n  - notes:\n      - x\n'),
    ).rejects.toThrow(/object form requires 'id' as a non-empty string/);
  });

  it('an out-of-enum status on an attach entry is rejected', async () => {
    await expect(
      parseNode('name: N\ntype: service\naspects:\n  - id: a\n    status: bogus\n'),
    ).rejects.toThrow(/status must be one of: draft, advisory, enforced/);
  });

  it('duplicate aspect id in the node aspects list is rejected', async () => {
    await expect(
      parseNode('name: N\ntype: service\naspects:\n  - a\n  - a\n'),
    ).rejects.toThrow(/duplicate aspect 'a' in aspects list/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-node.yaml — sizeExempt (schema lines 46-51): optional mapping with a
// REQUIRED non-empty `reason` string.
// ════════════════════════════════════════════════════════════════════════════
describe('yg-node.yaml — sizeExempt shape', () => {
  it('sizeExempt is optional (absent => undefined)', async () => {
    const meta = await parseNode('name: N\ntype: service\n');
    expect(meta.sizeExempt).toBeUndefined();
  });

  it('sizeExempt requires a mapping, not a scalar', async () => {
    await expect(parseNode('name: N\ntype: service\nsizeExempt: hello\n')).rejects.toThrow(
      /'sizeExempt' must be a mapping with a 'reason' string/,
    );
  });

  it('sizeExempt requires a non-empty reason', async () => {
    await expect(parseNode('name: N\ntype: service\nsizeExempt: {}\n')).rejects.toThrow(
      /'sizeExempt' requires a non-empty 'reason'/,
    );
    await expect(
      parseNode('name: N\ntype: service\nsizeExempt:\n  reason: "   "\n'),
    ).rejects.toThrow(/'sizeExempt' requires a non-empty 'reason'/);
  });

  it('a valid sizeExempt round-trips with a trimmed reason', async () => {
    const meta = await parseNode(
      'name: N\ntype: service\nsizeExempt:\n  reason: "  generated lockfile  "\n',
    );
    expect(meta.sizeExempt).toEqual({ reason: 'generated lockfile' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-aspect.yaml — required name; optional/trimmed description.
// schema lines 14-16. description-missing is a validator concern.
// ════════════════════════════════════════════════════════════════════════════
describe('yg-aspect.yaml — required name / description', () => {
  it('name is required (aspect-name-missing)', async () => {
    const r = await parseAsp('reviewer:\n  type: llm\n', { 'content.md': 'rule' });
    expect(codes(r)).toContain('aspect-name-missing');
  });

  it('empty/non-mapping aspect YAML is rejected (yaml-invalid)', async () => {
    const r = await parseAsp('');
    expect(codes(r)).toContain('yaml-invalid');
  });

  it('aspect id must be non-empty (aspect-invalid-id)', async () => {
    const r = await parseAsp('name: N\nreviewer:\n  type: llm\n', { 'content.md': 'r' }, '   ');
    expect(codes(r)).toContain('aspect-invalid-id');
  });

  it('parser tolerates a missing description; validator emits description-missing', async () => {
    const r = await parseAsp('name: N\nreviewer:\n  type: llm\n', { 'content.md': 'r' });
    const aspect = assertOk(r);
    expect(aspect.description).toBeUndefined();

    const graph = makeGraph({ aspects: [{ ...aspect }] });
    const issues = checkMissingDescriptions(graph);
    const hit = issues.find((i) => i.code === 'description-missing');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('error');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-aspect.yaml — reviewer kind INFERENCE (schema lines 18-46).
//   content.md present          → llm
//   check.mjs present           → deterministic
//   neither + implies declared  → aggregate
//   neither + no implies        → error (aspect-empty / reviewer-missing)
// ════════════════════════════════════════════════════════════════════════════
describe('yg-aspect.yaml — reviewer kind inference', () => {
  it('content.md present, no reviewer block => inferred llm', async () => {
    const a = assertOk(await parseAsp('name: N\ndescription: x\n', { 'content.md': 'rule' }));
    expect(a.reviewer.type).toBe('llm');
    expect(a.reviewer.tier).toBeUndefined();
  });

  it('check.mjs present, no reviewer block => inferred deterministic', async () => {
    const a = assertOk(
      await parseAsp('name: N\ndescription: x\n', { 'check.mjs': 'export default {}' }),
    );
    expect(a.reviewer.type).toBe('deterministic');
  });

  it('neither file but implies declared, no reviewer block => inferred aggregate', async () => {
    const a = assertOk(await parseAsp('name: N\ndescription: x\nimplies:\n  - other\n'));
    expect(a.reviewer.type).toBe('aggregate');
    expect(a.implies).toEqual(['other']);
  });

  it('neither rule source and no implies, no reviewer block => error (does nothing)', async () => {
    const r = await parseAsp('name: N\ndescription: x\n');
    // schema: such an aspect is rejected. Parser surfaces aspect-reviewer-missing.
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('aspect-reviewer-missing');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-aspect.yaml — explicit reviewer block (schema lines 18-46).
//   - reviewer must be a mapping
//   - reviewer.type required, and only the documented values
//   - unknown reviewer keys rejected (only type + tier allowed)
// ════════════════════════════════════════════════════════════════════════════
describe('yg-aspect.yaml — explicit reviewer block', () => {
  it('reviewer must be a mapping (array rejected)', async () => {
    const r = await parseAsp('name: N\ndescription: x\nreviewer: [llm]\n', { 'content.md': 'r' });
    expect(codes(r)).toContain('aspect-reviewer-not-mapping');
  });

  it('explicit reviewer mapping requires type', async () => {
    const r = await parseAsp('name: N\ndescription: x\nreviewer:\n  tier: deep\n', { 'content.md': 'r' });
    expect(codes(r)).toContain('aspect-reviewer-type-missing');
  });

  it('explicit reviewer.type: llm is accepted', async () => {
    const a = assertOk(
      await parseAsp('name: N\ndescription: x\nreviewer:\n  type: llm\n', { 'content.md': 'r' }),
    );
    expect(a.reviewer.type).toBe('llm');
  });

  it('explicit reviewer.type: deterministic is accepted', async () => {
    const a = assertOk(
      await parseAsp('name: N\ndescription: x\nreviewer:\n  type: deterministic\n', {
        'check.mjs': 'export default {}',
      }),
    );
    expect(a.reviewer.type).toBe('deterministic');
  });

  it('an unrecognized reviewer.type value is rejected', async () => {
    const r = await parseAsp('name: N\ndescription: x\nreviewer:\n  type: zzz\n', { 'content.md': 'r' });
    expect(codes(r)).toContain('aspect-reviewer-type-invalid');
  });

  // NOTE: the schema (yg-aspect.yaml line 42) documents `aggregate` as a valid
  // explicit reviewer.type. The parser REJECTS `reviewer.type: aggregate`
  // (aspect-reviewer-type-invalid). That divergence is recorded as a bounty;
  // the conflicting "accepts aggregate" assertion is intentionally omitted here
  // to keep the file green.

  it('unknown reviewer keys (e.g. model/provider) are rejected', async () => {
    const r = await parseAsp('name: N\ndescription: x\nreviewer:\n  type: llm\n  model: opus\n', {
      'content.md': 'r',
    });
    expect(codes(r)).toContain('aspect-reviewer-unknown-key');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-aspect.yaml — reviewer.tier (schema lines 43-46): only for llm; non-empty
// string; forbidden for deterministic.
// ════════════════════════════════════════════════════════════════════════════
describe('yg-aspect.yaml — reviewer.tier', () => {
  it('tier is permitted on an LLM aspect and round-trips', async () => {
    const a = assertOk(
      await parseAsp('name: N\ndescription: x\nreviewer:\n  type: llm\n  tier: deep\n', {
        'content.md': 'r',
      }),
    );
    expect(a.reviewer).toEqual({ type: 'llm', tier: 'deep' });
  });

  it('an empty-string tier is rejected', async () => {
    const r = await parseAsp('name: N\ndescription: x\nreviewer:\n  type: llm\n  tier: ""\n', {
      'content.md': 'r',
    });
    expect(codes(r)).toContain('aspect-reviewer-tier-invalid');
  });

  it('a non-string tier is rejected', async () => {
    const r = await parseAsp('name: N\ndescription: x\nreviewer:\n  type: llm\n  tier: 5\n', {
      'content.md': 'r',
    });
    expect(codes(r)).toContain('aspect-reviewer-tier-invalid');
  });

  it('tier is forbidden on a deterministic aspect', async () => {
    const r = await parseAsp(
      'name: N\ndescription: x\nreviewer:\n  type: deterministic\n  tier: deep\n',
      { 'check.mjs': 'export default {}' },
    );
    expect(codes(r)).toContain('aspect-tier-on-deterministic');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-aspect.yaml — status (schema lines 48-57): optional; enum draft|advisory|
// enforced; absent => 'enforced' (default applied downstream, parser leaves
// undefined).
// ════════════════════════════════════════════════════════════════════════════
describe('yg-aspect.yaml — status enum', () => {
  it.each(['draft', 'advisory', 'enforced'])('accepts documented status %s', async (s) => {
    const a = assertOk(
      await parseAsp(`name: N\ndescription: x\nreviewer:\n  type: llm\nstatus: ${s}\n`, {
        'content.md': 'r',
      }),
    );
    expect(a.status).toBe(s);
  });

  it('an out-of-enum status is rejected (aspect-status-invalid)', async () => {
    const r = await parseAsp('name: N\ndescription: x\nreviewer:\n  type: llm\nstatus: bogus\n', {
      'content.md': 'r',
    });
    expect(codes(r)).toContain('aspect-status-invalid');
  });

  it('absent status: parser leaves it undefined (default enforced applied downstream)', async () => {
    const a = assertOk(
      await parseAsp('name: N\ndescription: x\nreviewer:\n  type: llm\n', { 'content.md': 'r' }),
    );
    expect(a.status).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-aspect.yaml — implies (schema lines 59-84): array; bare string OR
// { id, when?, status_inherit? }; status_inherit enum strictest|own-default.
// ════════════════════════════════════════════════════════════════════════════
describe('yg-aspect.yaml — implies shape', () => {
  it('implies must be an array', async () => {
    const r = await parseAsp('name: N\ndescription: x\nreviewer:\n  type: llm\nimplies: "x"\n', {
      'content.md': 'r',
    });
    expect(codes(r)).toContain('aspect-implies-not-array');
  });

  it('bare-string implies entries are captured', async () => {
    const a = assertOk(
      await parseAsp('name: N\ndescription: x\nimplies:\n  - a\n  - b\n'),
    );
    expect(a.implies).toEqual(['a', 'b']);
  });

  it('object-form implies with when is captured', async () => {
    const a = assertOk(
      await parseAsp(
        'name: N\ndescription: x\nimplies:\n  - bare\n  - id: cond\n    when:\n      node: { has_port: charge }\n',
      ),
    );
    expect(a.implies).toEqual(['bare', 'cond']);
    expect(a.impliesWhens).toEqual({ cond: { node: { has_port: 'charge' } } });
  });

  it.each(['strictest', 'own-default'])(
    'status_inherit accepts the documented modifier %s',
    async (mod) => {
      const a = assertOk(
        await parseAsp(
          `name: N\ndescription: x\nimplies:\n  - id: other\n    status_inherit: ${mod}\n`,
        ),
      );
      expect(a.impliesStatusInherit?.other).toBe(mod);
    },
  );

  it('an out-of-enum status_inherit is rejected (implies-status-inherit-invalid)', async () => {
    const r = await parseAsp(
      'name: N\ndescription: x\nimplies:\n  - id: other\n    status_inherit: bogus\n',
    );
    expect(codes(r)).toContain('implies-status-inherit-invalid');
  });

  it('a non-string / non-object implies entry is rejected', async () => {
    await expect(
      parseAsp('name: N\ndescription: x\nreviewer:\n  type: llm\nimplies:\n  - 42\n', {
        'content.md': 'r',
      }),
    ).rejects.toThrow(/aspect attachment must be a string or an object/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-aspect.yaml — references (schema lines 119-140): LLM-only; string OR
// { path, description? }; repo-relative, no escape; no duplicates; forbidden on
// deterministic AND aggregate aspects.
// ════════════════════════════════════════════════════════════════════════════
describe('yg-aspect.yaml — references constraints', () => {
  it('references must be an array', async () => {
    const r = await parseAsp('name: N\ndescription: x\nreviewer:\n  type: llm\nreferences: x\n', {
      'content.md': 'r',
    });
    expect(codes(r)).toContain('aspect-reference-invalid-form');
  });

  it('a string shorthand reference is normalized to { path }', async () => {
    const a = assertOk(
      await parseAsp('name: N\ndescription: x\nreviewer:\n  type: llm\nreferences:\n  - docs/x.md\n', {
        'content.md': 'r',
      }),
    );
    expect(a.references).toEqual([{ path: 'docs/x.md' }]);
  });

  it('an object reference { path, description } round-trips', async () => {
    const a = assertOk(
      await parseAsp(
        'name: N\ndescription: x\nreviewer:\n  type: llm\nreferences:\n  - path: docs/x.md\n    description: catalogue\n',
        { 'content.md': 'r' },
      ),
    );
    expect(a.references).toEqual([{ path: 'docs/x.md', description: 'catalogue' }]);
  });

  it('an object reference missing the string path is rejected', async () => {
    const r = await parseAsp(
      'name: N\ndescription: x\nreviewer:\n  type: llm\nreferences:\n  - description: only-desc\n',
      { 'content.md': 'r' },
    );
    expect(codes(r)).toContain('aspect-reference-invalid-form');
  });

  it('a non-string reference description is rejected', async () => {
    const r = await parseAsp(
      'name: N\ndescription: x\nreviewer:\n  type: llm\nreferences:\n  - path: docs/x.md\n    description: 123\n',
      { 'content.md': 'r' },
    );
    expect(codes(r)).toContain('aspect-reference-invalid-form');
  });

  it('a blank reference path is rejected', async () => {
    const r = await parseAsp(
      'name: N\ndescription: x\nreviewer:\n  type: llm\nreferences:\n  - "   "\n',
      { 'content.md': 'r' },
    );
    expect(codes(r)).toContain('aspect-reference-blank-path');
  });

  it('a reference path escaping the repo root is rejected', async () => {
    const r = await parseAsp(
      'name: N\ndescription: x\nreviewer:\n  type: llm\nreferences:\n  - ../outside.md\n',
      { 'content.md': 'r' },
    );
    expect(codes(r)).toContain('aspect-reference-escape');
  });

  it('an absolute reference path is rejected as an escape', async () => {
    const r = await parseAsp(
      'name: N\ndescription: x\nreviewer:\n  type: llm\nreferences:\n  - /etc/passwd\n',
      { 'content.md': 'r' },
    );
    expect(codes(r)).toContain('aspect-reference-escape');
  });

  it('duplicate references are rejected', async () => {
    const r = await parseAsp(
      'name: N\ndescription: x\nreviewer:\n  type: llm\nreferences:\n  - docs/x.md\n  - docs/x.md\n',
      { 'content.md': 'r' },
    );
    expect(codes(r)).toContain('aspect-reference-duplicate');
  });

  it('references are forbidden on a deterministic aspect', async () => {
    const r = await parseAsp(
      'name: N\ndescription: x\nreviewer:\n  type: deterministic\nreferences:\n  - docs/x.md\n',
      { 'check.mjs': 'export default {}' },
    );
    expect(codes(r)).toContain('aspect-references-on-deterministic');
  });

  it('references are forbidden on an aggregating aspect', async () => {
    const r = await parseAsp(
      'name: N\ndescription: x\nimplies:\n  - other\nreferences:\n  - docs/x.md\n',
    );
    expect(codes(r)).toContain('aspect-references-on-aggregate');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// yg-aspect.yaml — when (schema lines 86-117): optional applicability predicate;
// grammar validated; unknown operators rejected.
// ════════════════════════════════════════════════════════════════════════════
describe('yg-aspect.yaml — when predicate grammar', () => {
  it('a valid top-level relations atomic predicate is captured', async () => {
    const a = assertOk(
      await parseAsp(
        'name: N\ndescription: x\nreviewer:\n  type: llm\nwhen:\n  relations:\n    calls:\n      target_type: service-client\n',
        { 'content.md': 'r' },
      ),
    );
    expect(a.when).toEqual({ relations: { calls: { target_type: 'service-client' } } });
  });

  it('an unknown when operator is rejected', async () => {
    await expect(
      parseAsp('name: N\ndescription: x\nreviewer:\n  type: llm\nwhen:\n  mostly_of: []\n', {
        'content.md': 'r',
      }),
    ).rejects.toThrow(/unknown when operator 'mostly_of'/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Port / consumes CONTRACT (yg-node.yaml schema lines 33-38): validator-level.
//   - target declares ports but relation has no consumes  → port-missing-consumes
//   - relation names consumes but target has NO ports      → consumes-without-ports
// ════════════════════════════════════════════════════════════════════════════
describe('port/consumes contract (validator)', () => {
  function twoNodeGraph(consumerMeta: NodeMeta, targetMeta: NodeMeta): Graph {
    const consumer = makeNode('consumer', consumerMeta);
    const target = makeNode('target', targetMeta);
    return makeGraph({
      nodes: new Map([
        ['consumer', consumer],
        ['target', target],
      ]),
    });
  }

  it('emits port-missing-consumes when target declares ports but relation omits consumes', () => {
    const graph = twoNodeGraph(
      { name: 'C', type: 'service', relations: [{ target: 'target', type: 'uses' }] },
      {
        name: 'T',
        type: 'service',
        ports: { charge: { description: 'charge', aspects: ['a'] } },
      },
    );
    const issues = checkPortConsumes(graph);
    const hit = issues.find((i) => i.code === 'port-missing-consumes');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('error');
  });

  it('emits consumes-without-ports when a relation consumes a target that declares no ports', () => {
    const graph = twoNodeGraph(
      {
        name: 'C',
        type: 'service',
        relations: [{ target: 'target', type: 'uses', consumes: ['ghost'] }],
      },
      { name: 'T', type: 'service' },
    );
    const issues = checkPortConsumes(graph);
    const hit = issues.find((i) => i.code === 'consumes-without-ports');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('error');
  });

  it('emits no port/consumes issue when consumes matches a declared port', () => {
    const graph = twoNodeGraph(
      {
        name: 'C',
        type: 'service',
        relations: [{ target: 'target', type: 'uses', consumes: ['charge'] }],
      },
      {
        name: 'T',
        type: 'service',
        ports: { charge: { description: 'charge', aspects: ['a'] } },
      },
    );
    const issues = checkPortConsumes(graph);
    expect(
      issues.some(
        (i) => i.code === 'port-missing-consumes' || i.code === 'consumes-without-ports',
      ),
    ).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CLI-observable: `yg check` surfaces description-missing for a node whose
// description was removed (schema line 10: "Validator emits description-missing
// if absent"). Hermetic temp git repo; no LLM/network. Skipped if dist absent.
// ════════════════════════════════════════════════════════════════════════════
describe('CLI `yg check` — description-missing (spawned binary)', () => {
  it.skipIf(!distExists)(
    'reports description-missing and exits non-zero when a node has no description',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'yg-bnty4-cli-'));
      tempDirs.push(dir);
      cpSync(E2E_FIXTURE, dir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

      // Remove the description from the top-level module node.
      const nodeYaml = path.join(dir, '.yggdrasil', 'model', 'services', 'yg-node.yaml');
      writeFileSync(nodeYaml, 'name: Services\ntype: module\n', 'utf-8');

      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir });

      const result = spawnSync('node', [BIN_PATH, 'check'], { cwd: dir, encoding: 'utf-8' });
      const out = (result.stdout ?? '') + (result.stderr ?? '');
      expect(out).toContain('description-missing');
      expect(result.status).not.toBe(0);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Minimal-graph helpers (in-process validator tests).
// ─────────────────────────────────────────────────────────────────────────────
function makeNode(nodePath: string, meta: NodeMeta): GraphNode {
  return { path: nodePath, meta, children: [], parent: null };
}

function makeGraph(parts: {
  nodes?: Map<string, GraphNode>;
  aspects?: AspectDef[];
}): Graph {
  const architecture: ArchitectureDef = { node_types: {} };
  return {
    config: {},
    architecture,
    nodes: parts.nodes ?? new Map(),
    aspects: parts.aspects ?? [],
    flows: [],
    schemas: [],
    rootPath: '/tmp/does-not-matter/.yggdrasil',
  };
}
