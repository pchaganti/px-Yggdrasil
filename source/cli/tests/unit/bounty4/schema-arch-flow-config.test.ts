import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseArchitecture } from '../../../src/io/architecture-parser.js';
import { parseFlow } from '../../../src/io/flow-parser.js';
import { parseConfig, ConfigParseError, DEFAULT_COVERAGE } from '../../../src/io/config-parser.js';
import { checkEnforceStrictWithoutWhen } from '../../../src/core/checks/architecture.js';
import type { Graph } from '../../../src/model/graph.js';

// ---------------------------------------------------------------------------
// SPEC-CONFORMANCE bounty audit for the three schema files:
//   .yggdrasil/schemas/yg-architecture.yaml
//   .yggdrasil/schemas/yg-flow.yaml
//   .yggdrasil/schemas/yg-config.yaml
// confronted against:
//   src/io/architecture-parser.ts
//   src/io/flow-parser.ts
//   src/io/config-parser.ts
// Each `it()` turns one documented invariant into a conformance assertion.
// All assertions in this file are GREEN; divergences are recorded out-of-band.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bounty4-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, content, 'utf-8');
  return file;
}

async function arch(content: string): Promise<ReturnType<typeof parseArchitecture>> {
  const f = await tempFile('yg-architecture.yaml', content);
  return parseArchitecture(f);
}

async function flow(content: string): Promise<ReturnType<typeof parseFlow>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bounty4-flow-'));
  tmpDirs.push(dir);
  const f = path.join(dir, 'yg-flow.yaml');
  await writeFile(f, content, 'utf-8');
  return parseFlow(dir, f);
}

async function cfg(content: string): Promise<ReturnType<typeof parseConfig>> {
  const f = await tempFile('yg-config.yaml', content);
  return parseConfig(f);
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// =====================================================================
// yg-architecture.yaml
// =====================================================================
describe('architecture schema conformance', () => {
  // SPEC: node_types.<id>.description — required; absent emits an error.
  it('requires a non-empty description on every node type', async () => {
    await expect(arch('node_types:\n  widget:\n    parents: []\n')).rejects.toThrow(
      /must have a non-empty 'description' string/,
    );
  });

  it('rejects a blank/whitespace-only description', async () => {
    await expect(arch('node_types:\n  widget:\n    description: "   "\n')).rejects.toThrow(
      /non-empty 'description'/,
    );
  });

  it('accepts a valid description-only type', async () => {
    const a = await arch('node_types:\n  widget:\n    description: A widget\n');
    expect(a.node_types.widget.description).toBe('A widget');
  });

  // SPEC: relation types are exactly calls|uses|extends|implements|emits|listens.
  it('rejects an unknown relation type under relations', async () => {
    await expect(
      arch('node_types:\n  widget:\n    description: x\n    relations:\n      invokes: [other]\n'),
    ).rejects.toThrow(/unknown relation type 'invokes'/);
  });

  it('accepts each of the six documented relation types', async () => {
    const a = await arch(
      'node_types:\n  widget:\n    description: x\n    relations:\n' +
        '      calls: [a]\n      uses: [a]\n      extends: [a]\n      implements: [a]\n      emits: [a]\n      listens: [a]\n',
    );
    const rels = a.node_types.widget.relations!;
    expect(Object.keys(rels).sort()).toEqual(
      ['calls', 'emits', 'extends', 'implements', 'listens', 'uses'].sort(),
    );
  });

  it('rejects a non-array relation target list', async () => {
    await expect(
      arch('node_types:\n  widget:\n    description: x\n    relations:\n      calls: not-a-list\n'),
    ).rejects.toThrow(/relations.calls must be an array/);
  });

  // SPEC: enforce accepts only the literal value `strict`.
  it('rejects enforce values other than "strict"', async () => {
    await expect(
      arch('node_types:\n  widget:\n    description: x\n    when:\n      path: "**/*.ts"\n    enforce: lax\n'),
    ).rejects.toThrow(/enforce must be 'strict'/);
  });

  it('accepts enforce: strict when combined with a when predicate', async () => {
    const a = await arch(
      'node_types:\n  widget:\n    description: x\n    when:\n      path: "**/*.ts"\n    enforce: strict\n',
    );
    expect(a.node_types.widget.enforce).toBe('strict');
  });

  // SPEC: "enforce: strict ... Requires `when`." Enforced by the validator
  // check (parser accepts it; the check fires enforce-strict-without-when).
  it('flags enforce: strict without a when predicate via the validator', async () => {
    const a = await arch('node_types:\n  widget:\n    description: x\n    enforce: strict\n');
    const graph = { architecture: a } as unknown as Graph;
    const issues = checkEnforceStrictWithoutWhen(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('enforce-strict-without-when');
  });

  it('does NOT flag enforce: strict that has a when predicate', async () => {
    const a = await arch(
      'node_types:\n  widget:\n    description: x\n    when:\n      path: "**/*.ts"\n    enforce: strict\n',
    );
    const graph = { architecture: a } as unknown as Graph;
    expect(checkEnforceStrictWithoutWhen(graph)).toHaveLength(0);
  });

  // SPEC: log_required — optional, default true; must be boolean.
  it('rejects a non-boolean log_required', async () => {
    await expect(
      arch('node_types:\n  widget:\n    description: x\n    log_required: "yes"\n'),
    ).rejects.toThrow(/log_required must be boolean/);
  });

  it('preserves an explicit log_required: false', async () => {
    const a = await arch('node_types:\n  widget:\n    description: x\n    log_required: false\n');
    expect(a.node_types.widget.log_required).toBe(false);
  });

  // SPEC: the default for log_required is true — represented by ABSENCE at the
  // parse layer (undefined => caller applies the true default).
  it('leaves log_required undefined when omitted (caller applies the true default)', async () => {
    const a = await arch('node_types:\n  widget:\n    description: x\n');
    expect(a.node_types.widget.log_required).toBeUndefined();
  });

  // SPEC: when grammar — path/content atoms, all_of/any_of/not boolean ops.
  it('parses a path atom when predicate', async () => {
    const a = await arch('node_types:\n  widget:\n    description: x\n    when:\n      path: "src/**/*.ts"\n');
    expect(a.node_types.widget.when).toEqual({ path: 'src/**/*.ts' });
  });

  it('parses combined path + content as implicit all_of (both atoms present)', async () => {
    const a = await arch(
      'node_types:\n  widget:\n    description: x\n    when:\n      path: "**/*.ts"\n      content: "export"\n',
    );
    expect(a.node_types.widget.when).toMatchObject({ path: '**/*.ts', content: 'export' });
  });

  it('rejects an unknown when operator', async () => {
    await expect(
      arch('node_types:\n  widget:\n    description: x\n    when:\n      glob: "**/*.ts"\n'),
    ).rejects.toThrow(/unknown when key 'glob'/);
  });

  it('rejects mixing a boolean operator with an atomic clause at the same level', async () => {
    await expect(
      arch(
        'node_types:\n  widget:\n    description: x\n    when:\n      path: "**/*.ts"\n      any_of:\n        - path: "**/*.js"\n',
      ),
    ).rejects.toThrow(/cannot mix boolean operators with atomic clauses/);
  });

  it('rejects an invalid regex in a content atom', async () => {
    await expect(
      arch('node_types:\n  widget:\n    description: x\n    when:\n      content: "([unclosed"\n'),
    ).rejects.toThrow(/Invalid regex in content/);
  });

  it('rejects an empty all_of array', async () => {
    await expect(
      arch('node_types:\n  widget:\n    description: x\n    when:\n      all_of: []\n'),
    ).rejects.toThrow(/'all_of' array must not be empty/);
  });

  // SPEC: parents — allowed parent node types (list of type-ids).
  it('preserves a parents list', async () => {
    const a = await arch('node_types:\n  widget:\n    description: x\n    parents: [root, mid]\n');
    expect(a.node_types.widget.parents).toEqual(['root', 'mid']);
  });

  it('rejects a non-string entry inside parents', async () => {
    await expect(
      arch('node_types:\n  widget:\n    description: x\n    parents: [root, 5]\n'),
    ).rejects.toThrow(/contains non-string/);
  });

  // SPEC: aspects — bare string OR object form { id, status?, when? }.
  it('parses a bare-string aspect entry', async () => {
    const a = await arch('node_types:\n  widget:\n    description: x\n    aspects:\n      - audit-logging\n');
    expect(a.node_types.widget.aspects).toEqual(['audit-logging']);
  });

  it('parses the object aspect form with status and when', async () => {
    const a = await arch(
      'node_types:\n  widget:\n    description: x\n    aspects:\n' +
        '      - id: audit\n        status: enforced\n        when:\n          node:\n            type: command\n',
    );
    expect(a.node_types.widget.aspects).toEqual(['audit']);
    expect(a.node_types.widget.aspectStatus).toEqual({ audit: 'enforced' });
    expect(a.node_types.widget.aspectWhens?.audit).toBeDefined();
  });

  it('rejects an object aspect with an invalid status value', async () => {
    await expect(
      arch('node_types:\n  widget:\n    description: x\n    aspects:\n      - id: audit\n        status: maybe\n'),
    ).rejects.toThrow(/status must be one of: draft, advisory, enforced/);
  });

  // SPEC: node_types must be a mapping; top level must be a mapping.
  it('rejects node_types declared as a list', async () => {
    await expect(arch('node_types:\n  - widget\n')).rejects.toThrow(
      /'node_types' must be a YAML mapping/,
    );
  });
});

// =====================================================================
// yg-flow.yaml
// =====================================================================
describe('flow schema conformance', () => {
  // SPEC: name — required, non-empty string.
  it('requires a non-empty name', async () => {
    await expect(flow('description: d\nnodes:\n  - a/b\n')).rejects.toThrow(/missing or empty 'name'/);
  });

  it('rejects a whitespace-only name', async () => {
    await expect(flow('name: "   "\nnodes:\n  - a/b\n')).rejects.toThrow(/missing or empty 'name'/);
  });

  // SPEC: nodes — required, non-empty array (alias: participants).
  it('requires nodes to be a non-empty array', async () => {
    await expect(flow('name: F\nnodes: []\n')).rejects.toThrow(
      /'nodes' \(or 'participants'\) must be a non-empty array/,
    );
  });

  it('rejects when both nodes and participants are absent', async () => {
    await expect(flow('name: F\n')).rejects.toThrow(/must be a non-empty array/);
  });

  it('accepts the participants alias for nodes', async () => {
    const f = await flow('name: F\nparticipants:\n  - a/b\n  - c/d\n');
    expect(f.nodes).toEqual(['a/b', 'c/d']);
  });

  it('rejects a non-string entry in nodes', async () => {
    await expect(flow('name: F\nnodes:\n  - a/b\n  - 42\n')).rejects.toThrow(/contains non-string/);
  });

  // SPEC: description — optional at parse layer (validator emits
  // description-missing); parser stores trimmed string or undefined.
  it('trims and preserves a present description', async () => {
    const f = await flow('name: F\ndescription: "  what it does  "\nnodes:\n  - a/b\n');
    expect(f.description).toBe('what it does');
  });

  it('leaves description undefined when absent (validator handles description-missing)', async () => {
    const f = await flow('name: F\nnodes:\n  - a/b\n');
    expect(f.description).toBeUndefined();
  });

  // SPEC: name itself is trimmed for display.
  it('trims the flow name', async () => {
    const f = await flow('name: "  OrderFlow  "\nnodes:\n  - a/b\n');
    expect(f.name).toBe('OrderFlow');
  });

  // SPEC: aspects — optional; bare string or object form { id, status?, when? }.
  it('parses bare-string flow aspects', async () => {
    const f = await flow('name: F\nnodes:\n  - a/b\naspects:\n  - simple\n');
    expect(f.aspects).toEqual(['simple']);
  });

  it('parses the object aspect form with status on a flow', async () => {
    const f = await flow(
      'name: F\nnodes:\n  - a/b\naspects:\n  - id: conditional\n    status: enforced\n',
    );
    expect(f.aspects).toEqual(['conditional']);
    expect(f.aspectStatus).toEqual({ conditional: 'enforced' });
  });

  it('rejects an invalid status value on a flow aspect', async () => {
    await expect(
      flow('name: F\nnodes:\n  - a/b\naspects:\n  - id: x\n    status: sometimes\n'),
    ).rejects.toThrow(/status must be one of: draft, advisory, enforced/);
  });

  it('rejects aspects declared as a non-array', async () => {
    await expect(flow('name: F\nnodes:\n  - a/b\naspects: simple\n')).rejects.toThrow(
      /'aspects' must be an array/,
    );
  });

  it('rejects an empty/non-mapping flow file', async () => {
    await expect(flow('- not\n- a\n- mapping\n')).rejects.toThrow(
      /empty or not a valid YAML mapping/,
    );
  });
});

// =====================================================================
// yg-config.yaml
// =====================================================================
describe('config schema conformance', () => {
  const TIER =
    'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n        endpoint: http://x\n';

  // SPEC: version — string, managed by CLI; parser trims it.
  it('reads and trims the version string', async () => {
    const c = await cfg('version: "  5.0.0  "\n' + TIER);
    expect(c.version).toBe('5.0.0');
  });

  // SPEC: quality.max_node_chars — positive integer; default 40000.
  it('defaults max_node_chars to 40000 when quality is absent', async () => {
    const c = await cfg(TIER);
    expect(c.quality?.max_node_chars).toBe(40000);
  });

  it('rejects a zero/negative/fractional max_node_chars', async () => {
    await expect(cfg('quality:\n  max_node_chars: 0\n' + TIER)).rejects.toBeInstanceOf(ConfigParseError);
    await expect(cfg('quality:\n  max_node_chars: -5\n' + TIER)).rejects.toThrow(
      /max_node_chars must be a positive integer/,
    );
    await expect(cfg('quality:\n  max_node_chars: 1.5\n' + TIER)).rejects.toThrow(
      /max_node_chars must be a positive integer/,
    );
  });

  it('preserves a valid custom max_node_chars', async () => {
    const c = await cfg('quality:\n  max_node_chars: 12345\n' + TIER);
    expect(c.quality?.max_node_chars).toBe(12345);
  });

  it('defaults max_direct_relations to 10 when quality is absent', async () => {
    const c = await cfg(TIER);
    expect(c.quality?.max_direct_relations).toBe(10);
  });

  it('rejects quality declared as a list', async () => {
    await expect(cfg('quality:\n  - 10\n' + TIER)).rejects.toThrow(/quality must be a mapping/);
  });

  // SPEC: parallel — positive integer, default 1.
  it('rejects parallel < 1', async () => {
    await expect(cfg('parallel: 0\n' + TIER)).rejects.toThrow(/positive integer >= 1/);
  });

  it('rejects a fractional parallel', async () => {
    await expect(cfg('parallel: 2.5\n' + TIER)).rejects.toThrow(/positive integer >= 1/);
  });

  it('rejects a non-numeric parallel', async () => {
    await expect(cfg('parallel: "two"\n' + TIER)).rejects.toThrow(/parallel must be a number/);
  });

  it('preserves a valid parallel value', async () => {
    const c = await cfg('parallel: 8\n' + TIER);
    expect(c.parallel).toBe(8);
  });

  // SPEC: debug — boolean, default false (off). debug: false ⇒ off.
  it('treats debug: true as on and debug: false as off', async () => {
    const on = await cfg('debug: true\n' + TIER);
    const off = await cfg('debug: false\n' + TIER);
    expect(on.debug).toBe(true);
    expect(off.debug).toBeFalsy();
  });

  // SPEC: coverage — absent ⇒ whole repo required (DEFAULT_COVERAGE).
  it('defaults coverage to require the whole repo when absent', async () => {
    const c = await cfg(TIER);
    expect(c.coverage).toEqual(DEFAULT_COVERAGE);
    expect(c.coverage).toEqual({ required: ['/'], excluded: [] });
  });

  it('defaults coverage.required to ["/"] when coverage present without required', async () => {
    const c = await cfg('coverage:\n  excluded:\n    - vendor/\n' + TIER);
    expect(c.coverage?.required).toEqual(['/']);
    expect(c.coverage?.excluded).toEqual(['vendor/']);
  });

  it('permits an explicit empty required list (require-nothing)', async () => {
    const c = await cfg('coverage:\n  required: []\n' + TIER);
    expect(c.coverage?.required).toEqual([]);
  });

  it('rejects a coverage root containing a ".." segment', async () => {
    await expect(cfg('coverage:\n  required:\n    - "../escape"\n' + TIER)).rejects.toThrow(
      /contains a '\.\.' segment/,
    );
  });

  it('rejects coverage declared as a non-mapping', async () => {
    await expect(cfg('coverage: "/"\n' + TIER)).rejects.toThrow(/coverage must be a mapping/);
  });

  // SPEC: reviewer.tiers — required, minimum one entry.
  it('rejects a reviewer with no tiers', async () => {
    await expect(cfg('reviewer:\n  default: standard\n')).rejects.toThrow(
      /reviewer.tiers is missing or not a mapping/,
    );
  });

  it('rejects a reviewer with an empty tiers mapping', async () => {
    await expect(cfg('reviewer:\n  tiers: {}\n')).rejects.toThrow(/reviewer.tiers is empty/);
  });

  it('rejects an unknown key directly under reviewer', async () => {
    await expect(cfg('reviewer:\n  provider: ollama\n  tiers:\n    s:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n')).rejects.toThrow(
      /unknown key 'provider' under reviewer:/,
    );
  });

  // SPEC: reviewer.default — required with >1 tier; optional with exactly one.
  it('requires reviewer.default when more than one tier is configured', async () => {
    await expect(
      cfg(
        'reviewer:\n  tiers:\n    a:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n        endpoint: http://x\n    b:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m2\n        endpoint: http://x\n',
      ),
    ).rejects.toThrow(/reviewer.default is required when multiple tiers/);
  });

  it('allows omitting reviewer.default with exactly one tier', async () => {
    const c = await cfg(TIER);
    expect(c.reviewer?.default).toBeUndefined();
    expect(Object.keys(c.reviewer!.tiers)).toEqual(['standard']);
  });

  it('rejects reviewer.default referencing an unknown tier', async () => {
    await expect(cfg('reviewer:\n  default: nope\n' + '  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n        endpoint: http://x\n')).rejects.toThrow(
      /no tier 'nope' is configured/,
    );
  });

  // SPEC: tier name regex ^[a-zA-Z][a-zA-Z0-9_-]{0,62}$, and `default` reserved.
  it('rejects a tier literally named "default"', async () => {
    await expect(
      cfg('reviewer:\n  tiers:\n    default:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n        endpoint: http://x\n'),
    ).rejects.toThrow(/tier name 'default' is reserved/);
  });

  it('rejects a tier name that violates the documented regex', async () => {
    await expect(
      cfg('reviewer:\n  tiers:\n    "1bad":\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n        endpoint: http://x\n'),
    ).rejects.toThrow(/tier name '1bad' is invalid/);
  });

  it('accepts a tier name at the 63-char maximum', async () => {
    const name = 'a' + 'b'.repeat(62); // 63 chars total
    const c = await cfg(`reviewer:\n  tiers:\n    ${name}:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n        endpoint: http://x\n`);
    expect(Object.keys(c.reviewer!.tiers)).toEqual([name]);
  });

  // SPEC: provider — one of the eight known providers.
  it('rejects an unknown provider', async () => {
    await expect(
      cfg('reviewer:\n  tiers:\n    s:\n      provider: bedrock\n      consensus: 1\n      config:\n        model: m\n'),
    ).rejects.toThrow(/unknown provider 'bedrock'/);
  });

  it('requires the provider field on a tier', async () => {
    await expect(
      cfg('reviewer:\n  tiers:\n    s:\n      consensus: 1\n      config:\n        model: m\n'),
    ).rejects.toThrow(/missing provider:/);
  });

  // SPEC: consensus — positive odd integer >= 1.
  it('rejects an even consensus', async () => {
    await expect(
      cfg('reviewer:\n  tiers:\n    s:\n      provider: ollama\n      consensus: 2\n      config:\n        model: m\n        endpoint: http://x\n'),
    ).rejects.toThrow(/invalid consensus/);
  });

  it('rejects a consensus below 1', async () => {
    await expect(
      cfg('reviewer:\n  tiers:\n    s:\n      provider: ollama\n      consensus: 0\n      config:\n        model: m\n        endpoint: http://x\n'),
    ).rejects.toThrow(/invalid consensus/);
  });

  it('requires consensus on a tier', async () => {
    await expect(
      cfg('reviewer:\n  tiers:\n    s:\n      provider: ollama\n      config:\n        model: m\n        endpoint: http://x\n'),
    ).rejects.toThrow(/missing consensus:/);
  });

  it('accepts an odd consensus >= 3', async () => {
    const c = await cfg('reviewer:\n  tiers:\n    s:\n      provider: ollama\n      consensus: 3\n      config:\n        model: m\n        endpoint: http://x\n');
    expect(c.reviewer!.tiers.s.consensus).toBe(3);
  });

  // SPEC: config — required mapping; must carry a model id.
  it('requires the config block on a tier', async () => {
    await expect(
      cfg('reviewer:\n  tiers:\n    s:\n      provider: ollama\n      consensus: 1\n'),
    ).rejects.toThrow(/missing config:/);
  });

  it('requires config.model (or a provider default) on a tier', async () => {
    await expect(
      cfg('reviewer:\n  tiers:\n    s:\n      provider: ollama\n      consensus: 1\n      config:\n        endpoint: http://x\n'),
    ).rejects.toThrow(/config.model is missing/);
  });

  it('supplies a provider default model for claude-code without explicit model', async () => {
    const c = await cfg('reviewer:\n  tiers:\n    s:\n      provider: claude-code\n      consensus: 1\n      config: {}\n');
    expect(c.reviewer!.tiers.s.model).toBe('haiku');
  });

  it('rejects an unknown key on a tier', async () => {
    await expect(
      cfg('reviewer:\n  tiers:\n    s:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n      bogus: 1\n'),
    ).rejects.toThrow(/unknown key 'bogus'/);
  });

  // SPEC: config.timeout documented in SECONDS — parser converts to ms.
  it('converts config.timeout from seconds to milliseconds', async () => {
    const c = await cfg('reviewer:\n  tiers:\n    s:\n      provider: claude-code\n      consensus: 1\n      config:\n        model: m\n        timeout: 300\n');
    expect(c.reviewer!.tiers.s.timeout).toBe(300_000);
  });

  // SPEC: references — optional sub-mapping with positive-integer byte caps.
  it('rejects a non-positive references.max_bytes_per_file', async () => {
    await expect(
      cfg('reviewer:\n  tiers:\n    s:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n        endpoint: http://x\n      references:\n        max_bytes_per_file: 0\n'),
    ).rejects.toThrow(/references.max_bytes_per_file/);
  });

  it('preserves valid references byte caps', async () => {
    const c = await cfg('reviewer:\n  tiers:\n    s:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n        endpoint: http://x\n      references:\n        max_bytes_per_file: 65536\n        max_total_bytes_per_aspect: 262144\n');
    expect(c.reviewer!.tiers.s.references).toEqual({
      max_bytes_per_file: 65536,
      max_total_bytes_per_aspect: 262144,
    });
  });

  it('rejects an unknown key under references', async () => {
    await expect(
      cfg('reviewer:\n  tiers:\n    s:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n        endpoint: http://x\n      references:\n        max_bytes: 1\n'),
    ).rejects.toThrow(/unknown key 'references.max_bytes'/);
  });

  // SPEC: top-level config must be a YAML mapping.
  it('rejects an empty config file', async () => {
    await expect(cfg('')).rejects.toThrow(/empty or not a valid YAML mapping/);
  });
});
