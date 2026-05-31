import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Hermetic E2E — RELATIONS: the relation-TYPE matrix (all six types allowed and
// forbidden), event pairing (both unpaired directions, multi-pair, self-pair),
// self / organizational targets, relation-broken, the add/remove dependency cascade,
// bare-relation aspect NON-propagation, and inbound/transitive blast radius. Harness
// reused from cli-deterministic-lifecycle.test.ts (run/BIN_PATH/skipIf + killReviewer
// for the two cascade scenarios that need an approve baseline). Fully hermetic.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const LIFECYCLE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const SCHEMAS_DIR = path.join(LIFECYCLE_FIXTURE, '.yggdrasil', 'schemas');

const distExists = existsSync(BIN_PATH);

// Port 1 never has a listener on any machine, so pointing the reviewer here
// makes the LLM aspect path deterministically unreachable with no dependency on
// any external host being present or absent.
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

// ---------------------------------------------------------------------------
// builder for a hand-rolled, source-free graph used by the pure-validation
// scenarios. A source-free graph keeps every validation outcome attributable
// to the relation metadata alone: no `when` predicate to satisfy, no aspect
// reviewer to run, no approve baseline to manage. The three required schemas
// are copied from the committed e2e-lifecycle fixture (read-only) so `yg check`
// emits no schema-missing noise, and the config carries the mandatory reviewer:
// section pointed at the dead loopback.
// ---------------------------------------------------------------------------

const CONFIG = [
  'version: "5.0.0"',
  'quality:',
  '  max_direct_relations: 10',
  'reviewer:',
  '  default: standard',
  '  tiers:',
  '    standard:',
  '      provider: ollama',
  '      consensus: 1',
  '      config:',
  '        model: "qwen2.5-coder:0.5b"',
  `        endpoint: "${DEAD_ENDPOINT}"`,
  '',
].join('\n');

// Architecture with a rich, fully-specified relation matrix. Every structural
// and event relation type has at least one allowed target type and at least one
// forbidden target type, so both halves of relation-target-forbidden are
// reachable. `module` is organizational (no `when`); `producer` permits `uses`
// to `module` so the organizational-target-allowed case is also reachable.
const ARCHITECTURE = [
  'node_types:',
  '  module:',
  '    description: Organizational grouping — parent only, no file mapping.',
  '    log_required: false',
  '  producer:',
  '    description: Initiates structural and event relations.',
  '    log_required: false',
  '    parents: [module]',
  '    relations:',
  '      calls: [consumer]',
  '      uses: [consumer, module]',
  '      extends: [base]',
  '      implements: [iface]',
  '      emits: [consumer]',
  '  consumer:',
  '    description: Receives calls and listens for events.',
  '    log_required: false',
  '    parents: [module]',
  '    relations:',
  '      listens: [producer]',
  '  base:',
  '    description: A base class target for extends.',
  '    log_required: false',
  '    parents: [module]',
  '  iface:',
  '    description: An interface target for implements.',
  '    log_required: false',
  '    parents: [module]',
  '',
].join('\n');

type NodeSpec = {
  /** node path under model/, e.g. "app/p" */
  pathUnder: string;
  type: string;
  /** raw relations block lines (without the leading `relations:` key) */
  relations?: string[];
  /** raw aspects block entries (bare ids) */
  aspects?: string[];
};

/**
 * Build a complete, source-free graph in a fresh temp dir. `nodes` describes
 * the model nodes; an `app` module root is always created as the common parent.
 */
function buildGraph(label: string, nodes: NodeSpec[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-relx-${label}-`));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(ygRoot, { recursive: true });
  cpSync(SCHEMAS_DIR, path.join(ygRoot, 'schemas'), { recursive: true });
  writeFileSync(path.join(ygRoot, 'yg-config.yaml'), CONFIG, 'utf-8');
  writeFileSync(path.join(ygRoot, 'yg-architecture.yaml'), ARCHITECTURE, 'utf-8');

  // Common module root.
  const appDir = path.join(ygRoot, 'model', 'app');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    path.join(appDir, 'yg-node.yaml'),
    ['name: App', 'description: Application root module.', 'type: module', ''].join('\n'),
    'utf-8',
  );

  for (const n of nodes) {
    const nodeDir = path.join(ygRoot, 'model', ...n.pathUnder.split('/'));
    mkdirSync(nodeDir, { recursive: true });
    const lines = [
      `name: ${n.pathUnder.split('/').pop()}`,
      `description: Node ${n.pathUnder}.`,
      `type: ${n.type}`,
    ];
    if (n.aspects && n.aspects.length > 0) {
      lines.push('aspects:');
      for (const a of n.aspects) lines.push(`  - ${a}`);
    }
    if (n.relations && n.relations.length > 0) {
      lines.push('relations:');
      for (const r of n.relations) lines.push(r);
    }
    lines.push('');
    writeFileSync(path.join(nodeDir, 'yg-node.yaml'), lines.join('\n'), 'utf-8');
  }
  return dir;
}

/** Write a zero-violation deterministic aspect under aspects/<id>/. */
function writeDeterministicAspect(dir: string, id: string): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      `name: ${id}`,
      `description: Deterministic aspect ${id} that never reports a violation.`,
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(aspectDir, 'check.mjs'),
    ['export default function check() {', '  return [];', '}', ''].join('\n'),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Approve-baseline fixture for the cascade scenarios. Copy the committed
// e2e-lifecycle fixture, strip its only LLM aspect (`has-doc-comment`), and
// kill the reviewer endpoint. The leaf services then carry only deterministic
// aspects, so approve records a baseline with no LLM call.
// ---------------------------------------------------------------------------

function deterministicLifecycle(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-relx-${label}-`));
  cpSync(LIFECYCLE_FIXTURE, dir, { recursive: true });
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${DEAD_ENDPOINT}"`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
  return dir;
}

const ordersNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');

const ORDERS_BASE = [
  'name: OrdersService',
  'description: Creates and retrieves customer orders.',
  'type: service',
  'aspects:',
  '  - wip-rule',
];

describe.skipIf(!distExists)('CLI E2E — relation-type matrix, event pairing, self/organizational targets, relational cascade', () => {
  // =========================================================================
  // R. Relation-TYPE matrix — every one of the six types validated.
  // =========================================================================

  // R1: all six relation types, each pointing at an ALLOWED target type, plus a
  //     correctly paired emits/listens — the whole matrix passes at once.
  it('R1: all six relation types between allowed target types pass check', () => {
    const dir = buildGraph('r1-allowed', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: [
          '  - target: app/c',
          '    type: calls',
          '  - target: app/c',
          '    type: uses',
          '  - target: app/b',
          '    type: extends',
          '  - target: app/i',
          '    type: implements',
          '  - target: app/c',
          '    type: emits',
          '    event_name: thing.happened',
        ],
      },
      {
        pathUnder: 'app/c',
        type: 'consumer',
        relations: [
          '  - target: app/p',
          '    type: listens',
          '    event_name: thing.happened',
        ],
      },
      { pathUnder: 'app/b', type: 'base' },
      { pathUnder: 'app/i', type: 'iface' },
    ]);
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('PASS');
      expect(stdout).not.toContain('relation-target-forbidden');
      expect(stdout).not.toContain('event-unpaired');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // R2: relation-target-forbidden for EACH constrained structural relation type
  //     pointing at a target type the architecture does not allow. Proves the
  //     forbidden path for calls / uses / extends / implements in one graph.
  it('R2: forbidden calls/uses/extends/implements targets each yield relation-target-forbidden', () => {
    const dir = buildGraph('r2-forbidden-structural', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: [
          // calls allows [consumer]; base is forbidden.
          '  - target: app/b',
          '    type: calls',
          // uses allows [consumer, module]; iface is forbidden.
          '  - target: app/i',
          '    type: uses',
          // extends allows [base]; iface is forbidden.
          '  - target: app/i',
          '    type: extends',
          // implements allows [iface]; base is forbidden.
          '  - target: app/b',
          '    type: implements',
        ],
      },
      { pathUnder: 'app/b', type: 'base' },
      { pathUnder: 'app/i', type: 'iface' },
    ]);
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      // One forbidden line per offending relation, each naming the declaring
      // node, the relation type, the target, and the target's type.
      expect(stdout).toContain('relation-target-forbidden');
      expect(stdout).toContain('Relation: calls -> app/b (type: base)');
      expect(stdout).toContain('Relation: uses -> app/i (type: iface)');
      expect(stdout).toContain('Relation: extends -> app/i (type: iface)');
      expect(stdout).toContain('Relation: implements -> app/b (type: base)');
      // The WHY enumerates the allowed targets for the relation type.
      expect(stdout).toContain("Allowed targets for 'calls': [consumer]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // R3: relation-target-forbidden for the EVENT family (emits) targeting a
  //     disallowed type. emits allows [consumer]; emitting to a `base` is
  //     forbidden. (The complementary listens omitted, so the same relation is
  //     also event-unpaired; both diagnostics fire and are asserted.)
  it('R3: a forbidden emits target yields relation-target-forbidden (and event-unpaired)', () => {
    const dir = buildGraph('r3-forbidden-emits', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: [
          '  - target: app/b',
          '    type: emits',
          '    event_name: bad.event',
        ],
      },
      { pathUnder: 'app/b', type: 'base' },
    ]);
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('relation-target-forbidden');
      expect(stdout).toContain('Relation: emits -> app/b (type: base)');
      expect(stdout).toContain("Allowed targets for 'emits': [consumer]");
      // The unpaired emit is independently reported.
      expect(stdout).toContain('event-unpaired');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // R4: a relation type that the architecture does NOT constrain for the source
  //     type is UNCONSTRAINED — allowed to ANY target. `consumer` only
  //     constrains `listens`; a `uses` relation from a consumer to a `base` is
  //     therefore permitted and check passes.
  it('R4: an unconstrained relation type (omitted from the type config) is allowed to any target', () => {
    const dir = buildGraph('r4-unconstrained', [
      {
        pathUnder: 'app/c',
        type: 'consumer',
        relations: [
          '  - target: app/b',
          '    type: uses',
        ],
      },
      { pathUnder: 'app/b', type: 'base' },
    ]);
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('PASS');
      expect(stdout).not.toContain('relation-target-forbidden');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // R5: an unknown relation type is rejected at PARSE time (node-parser), surfacing
  //     as yaml-invalid with the parser's `relations[<i>].type is invalid` reason.
  it('R5: an unknown relation type is rejected as a yaml-invalid parse error', () => {
    const dir = buildGraph('r5-invalid-type', [
      {
        pathUnder: 'app/c',
        type: 'consumer',
      },
    ]);
    try {
      // Inject an invalid relation type directly (buildGraph cannot, since it
      // only takes raw lines; we rewrite the node yaml).
      writeFileSync(
        path.join(dir, '.yggdrasil', 'model', 'app', 'c', 'yg-node.yaml'),
        [
          'name: c',
          'description: Node app/c.',
          'type: consumer',
          'relations:',
          '  - target: app',
          '    type: invokes',
          '',
        ].join('\n'),
        'utf-8',
      );
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('yaml-invalid');
      expect(stdout).toContain('relations[0].type is invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // E. Event pairing — emits MUST pair with a listens, in BOTH directions.
  // =========================================================================

  // E1: an emits with no complementary listens is event-unpaired, attributed to
  //     the EMITTER and naming both ends.
  it('E1: emits with no matching listens is event-unpaired (attributed to the emitter)', () => {
    const dir = buildGraph('e1-emits-unpaired', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: [
          '  - target: app/c',
          '    type: emits',
          '    event_name: e1',
        ],
      },
      { pathUnder: 'app/c', type: 'consumer' },
    ]);
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('event-unpaired');
      expect(stdout).toContain(
        "Node 'app/p' emits to 'app/c' but 'app/c' has no listens from 'app/p'.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E2: the REVERSE direction — a listens with no complementary emits is also
  //     event-unpaired, attributed to the LISTENER. (cli-relations test 2 only
  //     covers the emits-without-listens half.)
  it('E2: listens with no matching emits is event-unpaired (attributed to the listener)', () => {
    const dir = buildGraph('e2-listens-unpaired', [
      { pathUnder: 'app/p', type: 'producer' },
      {
        pathUnder: 'app/c',
        type: 'consumer',
        relations: [
          '  - target: app/p',
          '    type: listens',
          '    event_name: e1',
        ],
      },
    ]);
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('event-unpaired');
      expect(stdout).toContain(
        "Node 'app/c' listens from 'app/p' but 'app/p' has no emits to 'app/c'.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E3: MULTIPLE distinct emit/listen pairs, each correctly complemented, all
  //     pass. Two producers each emit to one of two consumers that listen back.
  it('E3: multiple correctly paired emits/listens relations all pass', () => {
    const dir = buildGraph('e3-multi-pair', [
      {
        pathUnder: 'app/p1',
        type: 'producer',
        relations: [
          '  - target: app/c1',
          '    type: emits',
          '    event_name: e1',
        ],
      },
      {
        pathUnder: 'app/p2',
        type: 'producer',
        relations: [
          '  - target: app/c2',
          '    type: emits',
          '    event_name: e2',
        ],
      },
      {
        pathUnder: 'app/c1',
        type: 'consumer',
        relations: [
          '  - target: app/p1',
          '    type: listens',
          '    event_name: e1',
        ],
      },
      {
        pathUnder: 'app/c2',
        type: 'consumer',
        relations: [
          '  - target: app/p2',
          '    type: listens',
          '    event_name: e2',
        ],
      },
    ]);
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('PASS');
      expect(stdout).not.toContain('event-unpaired');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E4: a node that emits AND listens to ITSELF on the same event is a valid
  //     self-pair — the pairing check is satisfied within the single node.
  it('E4: a node that emits and listens to itself is a valid event self-pair', () => {
    const dir = buildGraph('e4-self-pair', [
      {
        // producer emits to producer + listens from producer: declare a single
        // self-pairing node. The architecture must allow producer->producer for
        // both event types, so this scenario uses a bespoke architecture below.
        pathUnder: 'app/p',
        type: 'producer',
        relations: [
          '  - target: app/p',
          '    type: emits',
          '    event_name: tick',
          '  - target: app/p',
          '    type: listens',
          '    event_name: tick',
        ],
      },
    ]);
    try {
      // Override the architecture so producer may emit to / listen from producer.
      writeFileSync(
        path.join(dir, '.yggdrasil', 'yg-architecture.yaml'),
        [
          'node_types:',
          '  module:',
          '    description: Organizational grouping.',
          '    log_required: false',
          '  producer:',
          '    description: Self-eventing node.',
          '    log_required: false',
          '    parents: [module]',
          '    relations:',
          '      emits: [producer]',
          '      listens: [producer]',
          '',
        ].join('\n'),
        'utf-8',
      );
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('PASS');
      expect(stdout).not.toContain('event-unpaired');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E5: a node that emits to itself WITHOUT a self-listens is event-unpaired —
  //     the self-loop is held to the same pairing rule as a cross-node emit.
  it('E5: a self emit without a self listens is event-unpaired', () => {
    const dir = buildGraph('e5-self-emit-unpaired', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: [
          '  - target: app/p',
          '    type: emits',
          '    event_name: tick',
        ],
      },
    ]);
    try {
      writeFileSync(
        path.join(dir, '.yggdrasil', 'yg-architecture.yaml'),
        [
          'node_types:',
          '  module:',
          '    description: Organizational grouping.',
          '    log_required: false',
          '  producer:',
          '    description: Self-eventing node.',
          '    log_required: false',
          '    parents: [module]',
          '    relations:',
          '      emits: [producer]',
          '      listens: [producer]',
          '',
        ].join('\n'),
        'utf-8',
      );
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('event-unpaired');
      expect(stdout).toContain(
        "Node 'app/p' emits to 'app/p' but 'app/p' has no listens from 'app/p'.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // S. Self & organizational targets.
  // =========================================================================

  // S1: a STRUCTURAL self-relation (a node that `uses` itself) is reported as a
  //     structural-cycle of the form `app/p -> app/p`. (cli-validation-codes D3
  //     covers a two-node cycle; the single-node self-loop is distinct.)
  it('S1: a structural self-relation (uses itself) yields structural-cycle app/p -> app/p', () => {
    const dir = buildGraph('s1-self-cycle', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: [
          '  - target: app/p',
          '    type: uses',
        ],
      },
    ]);
    try {
      // producer must be permitted to `uses` its own type for the relation to
      // reach the cycle check (otherwise relation-target-forbidden short-circuits).
      writeFileSync(
        path.join(dir, '.yggdrasil', 'yg-architecture.yaml'),
        [
          'node_types:',
          '  module:',
          '    description: Organizational grouping.',
          '    log_required: false',
          '  producer:',
          '    description: Self-using node.',
          '    log_required: false',
          '    parents: [module]',
          '    relations:',
          '      uses: [producer]',
          '',
        ].join('\n'),
        'utf-8',
      );
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('structural-cycle');
      expect(stdout).toContain('Circular dependency: app/p -> app/p.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // S2: a relation that targets an ORGANIZATIONAL (parent module) node is
  //     ALLOWED when the architecture lists `module` for that relation type.
  //     `uses` allows [consumer, module], so producer --uses--> app passes.
  it('S2: a relation to an organizational module target is allowed when the architecture permits it', () => {
    const dir = buildGraph('s2-org-allowed', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: [
          '  - target: app',
          '    type: uses',
        ],
      },
    ]);
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('PASS');
      expect(stdout).not.toContain('relation-target-forbidden');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // S3: the same organizational target is FORBIDDEN for a relation type whose
  //     allowed list omits `module`. `calls` allows [consumer] only, so
  //     producer --calls--> app (type: module) is relation-target-forbidden.
  it('S3: a relation to an organizational module target is forbidden when the architecture omits it', () => {
    const dir = buildGraph('s3-org-forbidden', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: [
          '  - target: app',
          '    type: calls',
        ],
      },
    ]);
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('relation-target-forbidden');
      expect(stdout).toContain('Relation: calls -> app (type: module)');
      expect(stdout).toContain("Allowed targets for 'calls': [consumer]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // B. relation-broken — a relation whose target node does not exist.
  // =========================================================================

  // B1: a relation pointing at a nonexistent node is relation-broken, attributed
  //     to the declaring node and naming the unresolved target, with a hint that
  //     lists the sibling nodes that DO exist under the same parent prefix.
  it('B1: a relation to a nonexistent target node yields relation-broken', () => {
    const dir = buildGraph('b1-broken', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: [
          '  - target: app/ghost',
          '    type: calls',
        ],
      },
      { pathUnder: 'app/c', type: 'consumer' },
    ]);
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('relation-broken');
      expect(stdout).toContain("Relation target 'app/ghost' does not exist.");
      // Attributed to the declaring node.
      expect(stdout).toContain('app/p');
      // The existing-siblings hint surfaces the real nodes under app/.
      expect(stdout).toContain('Existing nodes in app/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // B2: when a relation is BOTH a forbidden-type AND points at a nonexistent
  //     target, only relation-broken fires — relation-target-forbidden requires
  //     the target to exist (it reads the target's type), so a missing target
  //     short-circuits the forbidden check.
  it('B2: a forbidden-type relation to a missing target reports only relation-broken', () => {
    const dir = buildGraph('b2-broken-not-forbidden', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        // `calls` allows [consumer]; even if app/ghost existed as some other
        // type, the target is missing so the forbidden check never runs.
        relations: [
          '  - target: app/ghost',
          '    type: calls',
        ],
      },
    ]);
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('relation-broken');
      expect(stdout).not.toContain('relation-target-forbidden');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // C. Context, impact, fan-out and aspect (non-)propagation.
  // =========================================================================

  // C1: `yg context --node` renders a node's outbound relations as Dependencies
  //     (each tagged with its relation type) and inbound relations as
  //     Dependents.
  it('C1: context --node lists outbound relations as Dependencies and inbound as Dependents', () => {
    const dir = buildGraph('c1-context', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: [
          '  - target: app/c',
          '    type: calls',
          '  - target: app/b',
          '    type: extends',
          '  - target: app/i',
          '    type: implements',
        ],
      },
      { pathUnder: 'app/c', type: 'consumer' },
      { pathUnder: 'app/b', type: 'base' },
      { pathUnder: 'app/i', type: 'iface' },
    ]);
    try {
      const producer = run(['context', '--node', 'app/p'], dir);
      expect(producer.status).toBe(0);
      expect(producer.stdout).toContain('Dependencies (3)');
      expect(producer.stdout).toContain('app/c (calls)');
      expect(producer.stdout).toContain('app/b (extends)');
      expect(producer.stdout).toContain('app/i (implements)');

      // The call target sees the producer as a dependent.
      const consumer = run(['context', '--node', 'app/c'], dir);
      expect(consumer.status).toBe(0);
      expect(consumer.stdout).toContain('Dependents (1)');
      expect(consumer.stdout).toContain('app/p');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // C2: `yg impact --node` reports the relational blast radius — direct
  //     dependents, transitive dependents through a chain of `uses` relations,
  //     and the aggregate node count.
  it('C2: impact --node reports direct and transitive dependents through a uses chain', () => {
    // p --uses--> c --uses--> b. Changing b drifts c directly and p transitively.
    const dir = buildGraph('c2-impact-chain', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: ['  - target: app/c', '    type: uses'],
      },
      {
        pathUnder: 'app/c',
        type: 'consumer',
        relations: ['  - target: app/b', '    type: uses'],
      },
      { pathUnder: 'app/b', type: 'base' },
    ]);
    try {
      // consumer must be allowed to `uses` a base for the chain to validate.
      writeFileSync(
        path.join(dir, '.yggdrasil', 'yg-architecture.yaml'),
        [
          'node_types:',
          '  module:',
          '    description: Organizational grouping.',
          '    log_required: false',
          '  producer:',
          '    description: Producer.',
          '    log_required: false',
          '    parents: [module]',
          '    relations:',
          '      uses: [consumer]',
          '  consumer:',
          '    description: Consumer.',
          '    log_required: false',
          '    parents: [module]',
          '    relations:',
          '      uses: [base]',
          '  base:',
          '    description: Base.',
          '    log_required: false',
          '    parents: [module]',
          '',
        ].join('\n'),
        'utf-8',
      );
      expect(run(['check'], dir).status).toBe(0);

      const { status, stdout } = run(['impact', '--node', 'app/b'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Directly dependent:');
      expect(stdout).toContain('app/c (uses)');
      expect(stdout).toContain('Transitively dependent:');
      expect(stdout).toContain('app/c <- app/p');
      expect(stdout).toContain('Blast radius: 2 nodes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // C3: high INBOUND fan-out — a single target with many inbound relations. The
  //     target's impact blast radius equals the number of inbound dependents.
  it('C3: a target with many inbound relations has a blast radius equal to the inbound count', () => {
    const nodes: NodeSpec[] = [{ pathUnder: 'app/c', type: 'consumer' }];
    for (let i = 1; i <= 5; i++) {
      nodes.push({
        pathUnder: `app/p${i}`,
        type: 'producer',
        relations: ['  - target: app/c', '    type: uses'],
      });
    }
    const dir = buildGraph('c3-inbound-fanout', nodes);
    try {
      expect(run(['check'], dir).status).toBe(0);
      const { status, stdout } = run(['impact', '--node', 'app/c'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Directly dependent:');
      expect(stdout).toContain('app/p1 (uses)');
      expect(stdout).toContain('app/p5 (uses)');
      expect(stdout).toContain('Blast radius: 5 nodes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // C4: high OUTBOUND fan-out — a node whose own relation count exceeds
  //     quality.max_direct_relations is a high-fan-out WARNING, not an error:
  //     check still passes (exit 0). cli-relations test 4 asserts the diagnostic
  //     on the sample fixture but, because that fixture carries a refused
  //     baseline, cannot pin the warning-not-error outcome — this does.
  it('C4: outbound fan-out over the limit is a non-blocking high-fan-out warning (exit 0)', () => {
    const dir = buildGraph('c4-outbound-fanout', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: [
          '  - target: app/c',
          '    type: calls',
          '  - target: app/c',
          '    type: uses',
        ],
      },
      { pathUnder: 'app/c', type: 'consumer' },
    ]);
    try {
      // Lower the limit so two relations exceed it.
      const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      writeFileSync(
        cfgPath,
        readFileSync(cfgPath, 'utf-8').replace(
          /max_direct_relations:\s*\d+/,
          'max_direct_relations: 1',
        ),
        'utf-8',
      );
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('high-fan-out');
      expect(stdout).toContain('Node has 2 direct relations (max: 1).');
      // A warning, not an error.
      expect(stdout).toContain('Warnings (1)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // C5: a BARE relation does NOT propagate the target's aspects to the source.
  //     `app/c` carries an own deterministic aspect; `app/p` --uses--> `app/c`
  //     bare (no `consumes`/port). The aspect appears on the target's effective
  //     set but never on the source's — proving channel-6 propagation needs a
  //     port, not a bare relation.
  it('C5: a bare relation does not propagate the target node\'s aspect to the source', () => {
    const dir = buildGraph('c5-no-propagation', [
      {
        pathUnder: 'app/p',
        type: 'producer',
        relations: ['  - target: app/c', '    type: uses'],
      },
      {
        pathUnder: 'app/c',
        type: 'consumer',
        aspects: ['target-only'],
      },
    ]);
    try {
      writeDeterministicAspect(dir, 'target-only');
      expect(run(['check'], dir).status).toBe(0);

      // The aspect is effective on the target...
      const target = run(['context', '--node', 'app/c'], dir);
      expect(target.status).toBe(0);
      expect(target.stdout).toContain('target-only');

      // ...but NOT on the bare-relation source.
      const source = run(['context', '--node', 'app/p'], dir);
      expect(source.status).toBe(0);
      expect(source.stdout).not.toContain('target-only');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // D. Relational cascade — adding / removing a relation drifts the source node.
  //    These use an approve baseline, so they run on the e2e-lifecycle fixture
  //    with the LLM aspect stripped and the reviewer killed.
  // =========================================================================

  // D1: ADDING a `uses` relation to a node's own yg-node.yaml drifts THAT node
  //     (its tracked dependency set changed); re-approving the node clears it.
  //     We pin the stable substring `dependency 'services/payments' metadata
  //     changed` plus the cascade banner and affected node. BUG (in
  //     .temp/dogfood-report.md): a node's OWN-metadata edit renders a cosmetic
  //     `parent node 'unknown' metadata changed` line; not asserted as correct.
  it('D1: adding a uses relation to a node drifts it (cascade); re-approve clears it', () => {
    const dir = deterministicLifecycle('d1-add-relation');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Add an allowed `uses` relation (service uses service) to orders.
      writeFileSync(
        ordersNodeYaml(dir),
        [
          ...ORDERS_BASE,
          'relations:',
          '  - target: services/payments',
          '    type: uses',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.stdout).toContain('cascade');
      expect(drifted.stdout).toContain(
        "dependency 'services/payments' metadata changed",
      );
      expect(drifted.stdout).toContain('services/orders');

      const reapprove = run(['approve', '--node', 'services/orders'], dir);
      expect(reapprove.status).toBe(0);
      expect(reapprove.stdout).toContain('Approved: services/orders');

      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // D2: REMOVING a previously-approved relation also drifts the node — the
  //     dependency's tracked yg-node.yaml is no longer read, so the baseline
  //     records a removed tracked file. Re-approving clears it.
  it('D2: removing an approved relation drifts the node (cascade); re-approve clears it', () => {
    const dir = deterministicLifecycle('d2-remove-relation');
    try {
      // Start WITH the relation, approve, confirm clean.
      writeFileSync(
        ordersNodeYaml(dir),
        [
          ...ORDERS_BASE,
          'relations:',
          '  - target: services/payments',
          '    type: uses',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Now REMOVE the relation.
      writeFileSync(
        ordersNodeYaml(dir),
        [...ORDERS_BASE, 'mapping:', '  - src/services/orders.ts', ''].join('\n'),
        'utf-8',
      );

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.stdout).toContain('cascade');
      // The dependency's yg-node.yaml is no longer tracked → removed-file cascade.
      expect(drifted.stdout).toContain('Tracked file removed');
      expect(drifted.stdout).toContain('services/payments');
      expect(drifted.stdout).toContain('services/orders');

      const reapprove = run(['approve', '--node', 'services/orders'], dir);
      expect(reapprove.status).toBe(0);
      expect(reapprove.stdout).toContain('Approved: services/orders');

      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
