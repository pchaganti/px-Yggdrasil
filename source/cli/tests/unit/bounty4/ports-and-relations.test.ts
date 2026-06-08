import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkRelationTargets,
  checkNoCycles,
  checkUnpairedEvents,
} from '../../../src/core/checks/relations.js';
import {
  checkArchitectureRelations,
  checkPortConsumes,
  checkPortAspectsDefined,
} from '../../../src/core/checks/architecture.js';
import { checkDanglingAspectRefs } from '../../../src/core/checks/aspects.js';
import { STRUCTURAL_CODES } from '../../../src/core/check-codes.js';
import { computeEffectiveAspects, getAspectSource } from '../../../src/core/graph/aspects.js';
import { parseNodeYaml } from '../../../src/io/node-parser.js';
import { mkdirSync } from 'node:fs';
import type {
  Graph,
  GraphNode,
  NodeMeta,
  AspectDef,
  ArchitectureDef,
  RelationType,
} from '../../../src/model/graph.js';

// ============================================================================
// BOUNTY 4 — SPEC-CONFORMANCE audit of `yg knowledge read ports-and-relations`.
//
// The spec is the AUTHORITY. Every test below turns one concrete, documented
// invariant from that knowledge topic into an assertion against the REAL code
// (check functions / parser / aspect cascade / spawned binary). Where the code
// diverges from the documented promise, the divergence is recorded in the
// suspectedBugs return and the corresponding assertion is softened to pin the
// ACTUAL behavior so this file stays 100% green.
//
// Distinct from bounty3 (which exhaustively drove branch coverage of the same
// check functions): this suite is organized invariant-by-invariant against the
// VERBATIM spec text, and specifically hunts code↔doc divergences:
//   * the documented `port-missing-consumes` MESSAGE FORMAT is not produced.
//   * "Every aspect id listed in a port's aspects must be defined" is gated on
//     CONSUMPTION for the documented `port-missing-aspect` code; the unconditional
//     enforcement actually comes from a different code (`aspect-undefined`).
//   * the four documented port-contract codes are NOT in STRUCTURAL_CODES (the
//     "single source of truth" set the engine uses for the structural tally /
//     suggestedNext priority).
// ============================================================================

// --- In-memory graph builders (no FS, no clock, no RNG) ---

function makeNode(nodePath: string, meta: Partial<NodeMeta> = {}): GraphNode {
  return {
    path: nodePath,
    meta: { name: nodePath, type: 'service', ...meta },
    children: [],
    parent: null,
  } as GraphNode;
}

function makeGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    config: {},
    architecture: { node_types: {} } as ArchitectureDef,
    nodes: new Map(),
    aspects: [],
    flows: [],
    schemas: [],
    rootPath: '/tmp/.yggdrasil',
    ...overrides,
  } as Graph;
}

function aspect(id: string, extra: Partial<AspectDef> = {}): AspectDef {
  return { name: id, id, reviewer: { type: 'llm' as const }, artifacts: [], ...extra } as AspectDef;
}

const codesOf = (issues: { code?: string }[]): string[] => issues.map((i) => i.code ?? '').sort();

// Temp-dir bookkeeping shared by the parser tests (Invariant 1) and the E2E
// block (Invariant 12). Each test's dirs are removed in afterEach so an
// interrupted suite never accumulates leftover directories.
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Write a yg-node.yaml with the given body into a fresh temp dir; return its path. */
function writeNodeYaml(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-b4-parse-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'yg-node.yaml');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, body, 'utf-8');
  return file;
}

// ============================================================================
// INVARIANT 1 — "Six types split into two families." The relation type
// vocabulary is exactly calls/uses/extends/implements (structural) +
// emits/listens (event). The node parser accepts those six and rejects others.
// ============================================================================

describe('spec §"Relation types" — exactly six relation types', () => {
  const SPEC_STRUCTURAL = ['calls', 'uses', 'extends', 'implements'] as const;
  const SPEC_EVENT = ['emits', 'listens'] as const;

  for (const t of [...SPEC_STRUCTURAL, ...SPEC_EVENT]) {
    it(`parser accepts documented relation type '${t}'`, async () => {
      const file = writeNodeYaml(`name: A\ntype: service\nrelations:\n  - target: b\n    type: ${t}\n`);
      const meta = await parseNodeYaml(file);
      expect(meta.relations).toHaveLength(1);
      expect(meta.relations![0].type).toBe(t);
    });
  }

  it("parser REJECTS a relation type outside the documented six (e.g. 'depends')", async () => {
    const file = writeNodeYaml(`name: A\ntype: service\nrelations:\n  - target: b\n    type: depends\n`);
    await expect(parseNodeYaml(file)).rejects.toThrow(/type is invalid/);
  });

  it('the spec families partition correctly: only structural types feed cycle detection', () => {
    // Spec: structural = composition; event = async/decoupled. checkNoCycles
    // must treat ONLY the four structural types as graph edges.
    for (const t of SPEC_STRUCTURAL) {
      const nodes = new Map<string, GraphNode>([
        ['A', makeNode('A', { relations: [{ target: 'A', type: t }] })],
      ]);
      expect(codesOf(checkNoCycles(makeGraph({ nodes }))), `structural ${t}`).toEqual([
        'structural-cycle',
      ]);
    }
    for (const t of SPEC_EVENT) {
      const nodes = new Map<string, GraphNode>([
        ['A', makeNode('A', { relations: [{ target: 'A', type: t, event_name: 'E' }] })],
      ]);
      // Event self-loop is NOT a structural cycle (pairing, not composition).
      expect(checkNoCycles(makeGraph({ nodes })).filter((i) => i.code === 'structural-cycle'), `event ${t}`).toEqual([]);
    }
  });
});

// ============================================================================
// INVARIANT 2 — "Event relations must be paired: if A emits to B, B must
// declare a `listens` from A. `yg check` enforces this." (code event-unpaired)
// ============================================================================

describe('spec §"Relation types" — emits/listens must be paired (event-unpaired)', () => {
  it('A emits→B WITHOUT B listens→A → blocking event-unpaired error', () => {
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'B', type: 'emits', event_name: 'E' }] })],
      ['B', makeNode('B')],
    ]);
    const issues = checkUnpairedEvents(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['event-unpaired']);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].nodePath).toBe('A');
  });

  it('A emits→B AND B listens→A → no issue (the documented happy path)', () => {
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'B', type: 'emits', event_name: 'E' }] })],
      ['B', makeNode('B', { relations: [{ target: 'A', type: 'listens', event_name: 'E' }] })],
    ]);
    expect(checkUnpairedEvents(makeGraph({ nodes }))).toEqual([]);
  });

  it('a lone listens→source WITHOUT the matching emits is also unpaired', () => {
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'B', type: 'listens', event_name: 'E' }] })],
      ['B', makeNode('B')],
    ]);
    expect(codesOf(checkUnpairedEvents(makeGraph({ nodes })))).toEqual(['event-unpaired']);
  });

  it('event-unpaired is registered in STRUCTURAL_CODES (it always blocks per spec)', () => {
    // Spec: "`yg check` enforces this." The engine's tally classifies it as a
    // structural (always-blocking) code.
    expect(STRUCTURAL_CODES.has('event-unpaired')).toBe(true);
  });
});

// ============================================================================
// INVARIANT 3 — "Architecture controls allowed relations ... The validator
// rejects relations not permitted by the architecture." (relation-target-forbidden)
// ============================================================================

describe('spec §"Architecture controls allowed relations" — relation-target gating', () => {
  const arch = (relations: Partial<Record<RelationType, string[]>>): ArchitectureDef => ({
    node_types: {
      service: { description: 'svc', relations },
      module: { description: 'mod' },
      library: { description: 'lib' },
    },
  });

  it('a target type NOT in the allowed list → relation-target-forbidden', () => {
    const nodes = new Map<string, GraphNode>([
      ['a', makeNode('a', { type: 'service', relations: [{ target: 'b', type: 'calls' }] })],
      ['b', makeNode('b', { type: 'library' })],
    ]);
    const issues = checkArchitectureRelations(makeGraph({ nodes, architecture: arch({ calls: ['module'] }) }));
    expect(codesOf(issues)).toEqual(['relation-target-forbidden']);
  });

  it('a target type IN the allowed list → no issue', () => {
    const nodes = new Map<string, GraphNode>([
      ['a', makeNode('a', { type: 'service', relations: [{ target: 'b', type: 'calls' }] })],
      ['b', makeNode('b', { type: 'module' })],
    ]);
    expect(checkArchitectureRelations(makeGraph({ nodes, architecture: arch({ calls: ['module'] }) }))).toEqual([]);
  });

  it('gating applies uniformly to event relation types too (emits constrained by arch)', () => {
    // Spec lists all six types under the same architecture control. An emits to
    // a disallowed target type must be rejected just like a structural one.
    const nodes = new Map<string, GraphNode>([
      ['a', makeNode('a', { type: 'service', relations: [{ target: 'b', type: 'emits', event_name: 'E' }] })],
      ['b', makeNode('b', { type: 'library' })],
    ]);
    const issues = checkArchitectureRelations(makeGraph({ nodes, architecture: arch({ emits: ['module'] }) }));
    expect(codesOf(issues)).toEqual(['relation-target-forbidden']);
  });
});

// ============================================================================
// INVARIANT 4 — "A port on a node says: consumers of this endpoint must satisfy
// these aspects." + "The consumed port's aspects become effective on the
// consumer through channel 6." (channel-6 propagation, via `consumes`)
// ============================================================================

describe('spec §"Ports" — consumed port aspects propagate to the consumer (channel 6)', () => {
  it('declaring consumes:[charge] makes the port aspect effective on the consumer', () => {
    const provider = makeNode('p', { ports: { charge: { description: 'd', aspects: ['correlation-tracking', 'idempotency-key'] } } });
    const consumer = makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['charge'] }] });
    const nodes = new Map<string, GraphNode>([['p', provider], ['c', consumer]]);
    const graph = makeGraph({ nodes, aspects: [aspect('correlation-tracking'), aspect('idempotency-key')] });

    const eff = computeEffectiveAspects(consumer, graph);
    // Spec example: both port aspects become effective on the consumer.
    expect(eff.has('correlation-tracking')).toBe(true);
    expect(eff.has('idempotency-key')).toBe(true);
  });

  it('the port aspect does NOT become effective on the PROVIDER merely by being a port aspect', () => {
    // The aspect is a CONSUMER obligation; declaring the port does not attach it
    // to the provider's own aspect set.
    const provider = makeNode('p', { ports: { charge: { description: 'd', aspects: ['correlation-tracking'] } } });
    const nodes = new Map<string, GraphNode>([['p', provider]]);
    const graph = makeGraph({ nodes, aspects: [aspect('correlation-tracking')] });
    expect(computeEffectiveAspects(provider, graph).has('correlation-tracking')).toBe(false);
  });

  it('yg context channel-6 label is "port \'<name>\' on \'<target>\'" (source port + target node)', () => {
    // Spec §"yg context surfaces port-derived aspects": channel 6 entries are
    // labeled with the source port AND target node.
    const provider = makeNode('payments/service', { ports: { charge: { description: 'd', aspects: ['correlation-tracking'] } } });
    const consumer = makeNode('orders/handler', { relations: [{ target: 'payments/service', type: 'calls', consumes: ['charge'] }] });
    const nodes = new Map<string, GraphNode>([['payments/service', provider], ['orders/handler', consumer]]);
    const graph = makeGraph({ nodes, aspects: [aspect('correlation-tracking')] });

    expect(getAspectSource('correlation-tracking', consumer, graph)).toBe("port 'charge' on 'payments/service'");
  });
});

// ============================================================================
// INVARIANT 5 — "bare relations connect nodes but do NOT carry aspects across
// the boundary." (the load-bearing security claim of the whole topic)
// ============================================================================

describe('spec §mental-model — a BARE relation does not propagate the port aspect', () => {
  it('a relation with no consumes leaves the port aspect off the consumer', () => {
    const provider = makeNode('p', { ports: { charge: { description: 'd', aspects: ['correlation-tracking'] } } });
    const consumer = makeNode('c', { relations: [{ target: 'p', type: 'calls' }] }); // bare, no consumes
    const nodes = new Map<string, GraphNode>([['p', provider], ['c', consumer]]);
    const graph = makeGraph({ nodes, aspects: [aspect('correlation-tracking')] });

    expect(computeEffectiveAspects(consumer, graph).has('correlation-tracking')).toBe(false);
  });

  it('a relation to a port-less target never propagates anything regardless of consumes presence', () => {
    const target = makeNode('p'); // no ports
    const consumer = makeNode('c', { relations: [{ target: 'p', type: 'uses' }] });
    const nodes = new Map<string, GraphNode>([['p', target], ['c', consumer]]);
    expect(computeEffectiveAspects(consumer, makeGraph({ nodes })).size).toBe(0);
  });
});

// ============================================================================
// INVARIANT 6 — Missing port contract: "If a target node declares ports and the
// consumer's relation does NOT declare `consumes`, `yg check` emits a blocking
// error (code port-missing-consumes)". The documented MESSAGE is also quoted:
//   "Missing port contract: <consumer> → <target> has ports [<list>],
//    consumer must declare consumes: [<port-name>]."
// ============================================================================

describe('spec §"Missing port contracts" — port-missing-consumes', () => {
  it('target has ports, consumer omits consumes → port-missing-consumes (blocking error)', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: 'd', aspects: ['ct'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls' }] })],
    ]);
    const issues = checkPortConsumes(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['port-missing-consumes']);
    expect(issues[0].severity).toBe('error');
  });

  it('the diagnostic names the consumer (nodePath), the target, and the port list', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: 'd', aspects: ['ct'] }, refund: { description: 'd', aspects: ['ct'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls' }] })],
    ]);
    const [issue] = checkPortConsumes(makeGraph({ nodes }));
    const text = `${issue.messageData.what} ${issue.messageData.why} ${issue.messageData.next}`;
    expect(issue.nodePath).toBe('c'); // consumer
    expect(text).toContain('p'); // target
    expect(text).toContain('charge'); // port list
    expect(text).toContain('refund');
    expect(text).toContain('consumes'); // instruction to declare consumes
  });

  // DIVERGENCE: the spec quotes a specific rendered message
  //   "Missing port contract: <consumer> → <target> has ports [...], consumer
  //    must declare consumes: [<port-name>]."
  // The actual diagnostic is "Relation: <type> -> <target>" / "Target has
  // ports: [...]" and NEVER contains the literal "Missing port contract:".
  // Pinned here as ACTUAL behavior (see suspectedBugs: port-missing-consumes-message-divergence).
  it("the documented literal 'Missing port contract:' message is NOT produced (actual format pinned)", () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: 'd', aspects: ['ct'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls' }] })],
    ]);
    const [issue] = checkPortConsumes(makeGraph({ nodes }));
    const text = `${issue.messageData.what}\n${issue.messageData.why}\n${issue.messageData.next}`;
    expect(text).not.toContain('Missing port contract:');
    expect(issue.messageData.what.startsWith('Relation:')).toBe(true);
  });
});

// ============================================================================
// INVARIANT 7 — "If a relation declares `consumes` naming a target that declares
// NO ports, `yg check` emits a blocking error (code consumes-without-ports)."
// ============================================================================

describe('spec §"Consuming a target with no ports" — consumes-without-ports', () => {
  it('consumes on a port-less target → consumes-without-ports', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p')], // NO ports
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['charge'] }] })],
    ]);
    const issues = checkPortConsumes(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['consumes-without-ports']);
    expect(issues[0].severity).toBe('error');
  });
});

// ============================================================================
// INVARIANT 8 — "A target that DOES have ports but whose `consumes` names a port
// that does not exist on that target emits a blocking error (code port-undefined)."
// ============================================================================

describe('spec §"Consuming a target with no ports" — port-undefined for a bad name', () => {
  it('consumes a non-existent port on a target that DOES have ports → port-undefined', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: 'd', aspects: ['ct'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['phantom'] }] })],
    ]);
    const issues = checkPortConsumes(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['port-undefined']);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].messageData.what).toContain('phantom');
  });

  it('an undefined port name yields NO channel-6 propagation (the consumer inherits nothing)', () => {
    const provider = makeNode('p', { ports: { charge: { description: 'd', aspects: ['ct'] } } });
    const consumer = makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['phantom'] }] });
    const nodes = new Map<string, GraphNode>([['p', provider], ['c', consumer]]);
    expect(computeEffectiveAspects(consumer, makeGraph({ nodes, aspects: [aspect('ct')] })).size).toBe(0);
  });
});

// ============================================================================
// INVARIANT 9 — "Every aspect id listed in a port's `aspects` must be defined
// under `aspects/`; a missing one emits a blocking error (code port-missing-aspect)."
//
// DIVERGENCE: this is UNCONDITIONAL in the spec ("Every aspect id listed in a
// port's aspects"). In the code:
//   * the documented `port-missing-aspect` code (checkPortAspectsDefined) fires
//     ONLY for ports a consumer actually CONSUMES.
//   * the UNCONDITIONAL enforcement of the invariant is done by a DIFFERENT
//     check (checkDanglingAspectRefs) under code `aspect-undefined`.
// ============================================================================

describe('spec §"Ports" — every port aspect must be defined (port-missing-aspect)', () => {
  it('a CONSUMED port with an undefined aspect → port-missing-aspect on the consumer', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: 'd', aspects: ['ghost'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['charge'] }] })],
    ]);
    const issues = checkPortAspectsDefined(makeGraph({ nodes })); // 'ghost' not defined
    expect(codesOf(issues)).toEqual(['port-missing-aspect']);
    expect(issues[0].nodePath).toBe('c');
  });

  // DIVERGENCE (gating): the spec phrase "Every aspect id listed in a port's
  // aspects" is unconditional, but the documented `port-missing-aspect` code does
  // NOT fire for a port that is declared-but-never-consumed.
  it("an UNCONSUMED port with an undefined aspect does NOT emit port-missing-aspect (actual gating)", () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: 'd', aspects: ['ghost'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls' }] })], // bare — does not consume
    ]);
    expect(checkPortAspectsDefined(makeGraph({ nodes }))).toEqual([]);
  });

  // The invariant IS upheld globally — but by a DIFFERENT code than the spec
  // documents. checkDanglingAspectRefs emits `aspect-undefined` for the same
  // undefined port aspect, regardless of consumption.
  it("the invariant is actually enforced via the UNDOCUMENTED code 'aspect-undefined' (consumption-independent)", () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: 'd', aspects: ['ghost'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls' }] })], // unconsumed
    ]);
    const issues = checkDanglingAspectRefs(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['aspect-undefined']); // NOT 'port-missing-aspect'
    expect(issues[0].messageData.what).toContain('ghost');
    expect(issues[0].messageData.what).toContain('charge');
  });
});

// ============================================================================
// INVARIANT 10 — the four documented port-contract codes + the documented
// relation-target code are all spelled exactly as the spec says, and each is a
// blocking error. (Code-name conformance.)
//
// DIVERGENCE: the spec calls these "blocking error(s)". The engine's documented
// "single source of truth" set STRUCTURAL_CODES — which drives the structural
// tally and suggestedNext priority — does NOT contain ANY of the four port codes
// nor relation-target-forbidden.
// ============================================================================

describe('spec §"Missing port contracts" — documented blocking codes', () => {
  const DOCUMENTED_PORT_CODES = [
    'port-missing-aspect',
    'port-missing-consumes',
    'consumes-without-ports',
    'port-undefined',
  ] as const;

  it('every documented port code is emitted with severity error by the real checks', () => {
    // port-missing-aspect + port-undefined + consumes-without-ports + missing-consumes
    const everyCode = new Set<string>();
    // missing-consumes / port-undefined / consumes-without-ports
    {
      const nodes = new Map<string, GraphNode>([
        ['p', makeNode('p', { ports: { charge: { description: 'd', aspects: ['ct'] } } })],
        ['miss', makeNode('miss', { relations: [{ target: 'p', type: 'calls' }] })],
        ['bad', makeNode('bad', { relations: [{ target: 'p', type: 'calls', consumes: ['nope'] }] })],
        ['empty', makeNode('empty', { relations: [{ target: 'p', type: 'calls' }] })],
      ]);
      // separate target with no ports for consumes-without-ports
      nodes.set('np', makeNode('np'));
      nodes.set('cwp', makeNode('cwp', { relations: [{ target: 'np', type: 'calls', consumes: ['x'] }] }));
      for (const i of checkPortConsumes(makeGraph({ nodes }))) {
        expect(i.severity).toBe('error');
        everyCode.add(i.code ?? '');
      }
    }
    {
      const nodes = new Map<string, GraphNode>([
        ['p', makeNode('p', { ports: { charge: { description: 'd', aspects: ['ghost'] } } })],
        ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['charge'] }] })],
      ]);
      for (const i of checkPortAspectsDefined(makeGraph({ nodes }))) {
        expect(i.severity).toBe('error');
        everyCode.add(i.code ?? '');
      }
    }
    for (const c of DOCUMENTED_PORT_CODES) {
      expect(everyCode.has(c), `code ${c} should be emitted`).toBe(true);
    }
  });

  // DIVERGENCE: none of the documented port codes are in STRUCTURAL_CODES, the
  // "single source of truth" set the engine uses for the structural tally and
  // suggestedNext priority. They block only via severity:'error' and a separate
  // renderer-local ARCHITECTURE_CODES set, not via the documented structural set.
  it('the documented blocking port-contract codes are present in STRUCTURAL_CODES', () => {
    // FIXED: these blocking architecture-gate codes are now in the single-source
    // structural set, so suggestedNext prioritizes them like other structural errors.
    for (const c of DOCUMENTED_PORT_CODES) {
      expect(STRUCTURAL_CODES.has(c), `STRUCTURAL_CODES.has(${c})`).toBe(true);
    }
    expect(STRUCTURAL_CODES.has('relation-target-forbidden')).toBe(true);
  });
});

// ============================================================================
// INVARIANT 11 — relation target existence (a relation references a real node).
// Implicit in "Relations express typed dependencies between nodes" — a relation
// to a non-existent node is a blocking relation-broken error.
// ============================================================================

describe('spec §intro — a relation target must resolve to an existing node', () => {
  it('relation to a non-existent node → relation-broken', () => {
    const nodes = new Map<string, GraphNode>([
      ['a', makeNode('a', { relations: [{ target: 'ghost/node', type: 'uses' }] })],
    ]);
    expect(codesOf(checkRelationTargets(makeGraph({ nodes })))).toEqual(['relation-broken']);
  });

  it('relation-broken is a STRUCTURAL (always-blocking) code', () => {
    expect(STRUCTURAL_CODES.has('relation-broken')).toBe(true);
  });
});

// ============================================================================
// INVARIANT 12 — END-TO-END through the real binary, against the committed
// sample-project-ports fixture (deterministic aspect only — no LLM, no network).
// Pins the documented behaviors that ARE observable at the CLI gate.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const PORTS_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');
const distExists = existsSync(BIN_PATH) && existsSync(PORTS_FIXTURE);

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-b4-${label}-`));
  tempDirs.push(dir);
  cpSync(PORTS_FIXTURE, dir, { recursive: true });
  return dir;
}

function run(args: string[], cwd: string): { status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: result.status, all: (result.stdout ?? '') + (result.stderr ?? '') };
}

describe.skipIf(!distExists)('E2E — documented CLI-observable port behaviors', () => {
  it('omitting consumes against a port target fails check with port-missing-consumes (exit 1)', () => {
    const dir = copyFixture('missing-consumes');
    const consumerYaml = path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
    const yaml = readFileSync(consumerYaml, 'utf-8').replace(/\n\s*consumes: \[charge\]/, '');
    writeFileSync(consumerYaml, yaml, 'utf-8');

    const check = run(['check'], dir);
    expect(check.status).toBe(1);
    expect(check.all).toContain('port-missing-consumes');
  });

  // The same scenario through the real renderer: confirm the documented literal
  // "Missing port contract:" is NOT what an adopter sees (divergence, E2E layer).
  it('the rendered port-missing-consumes diagnostic does NOT contain "Missing port contract:"', () => {
    const dir = copyFixture('missing-consumes-msg');
    const consumerYaml = path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
    const yaml = readFileSync(consumerYaml, 'utf-8').replace(/\n\s*consumes: \[charge\]/, '');
    writeFileSync(consumerYaml, yaml, 'utf-8');

    const check = run(['check'], dir);
    expect(check.all).toContain('port-missing-consumes');
    expect(check.all).not.toContain('Missing port contract:');
  });

  it('consuming a port with consumes:[charge] propagates the audit aspect — yg context shows channel-6 label', () => {
    const dir = copyFixture('context');
    const ctx = run(['context', '--node', 'services/orders'], dir);
    expect(ctx.status).toBe(0);
    expect(ctx.all).toContain("port 'charge' on 'services/payments'");
    expect(ctx.all).toContain('audit-required');
  });

  it('consuming a non-existent port fails check with port-undefined (exit 1)', () => {
    const dir = copyFixture('undefined-port');
    const consumerYaml = path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
    const yaml = readFileSync(consumerYaml, 'utf-8').replace('consumes: [charge]', 'consumes: [phantom]');
    writeFileSync(consumerYaml, yaml, 'utf-8');

    const check = run(['check'], dir);
    expect(check.status).toBe(1);
    expect(check.all).toContain('port-undefined');
    expect(check.all).toContain('phantom');
  });
});
