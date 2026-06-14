import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relationRefusedMessage, relationUnverifiedMessage } from '../../../src/relations/messages.js';
import { allowedRelationTypes } from '../../../src/relations/allowed-types.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';
import type { Violation } from '../../../src/relations/verifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

function node(nodePath: string, type: string): GraphNode {
  return {
    path: nodePath,
    meta: { name: nodePath.split('/').pop() ?? nodePath, type },
    children: [],
    parent: null,
  };
}

/**
 * Architecture. NOTE the validator semantics (mirrored by allowedRelationTypes):
 * a relation type ABSENT from a type's `relations:` table is UNCONSTRAINED — it
 * may target any node type. A PRESENT relation type constrains its targets.
 *
 *   service: every relation type present, each with an explicit target list →
 *            fully constrained, so dead-ends are reachable. uses→[service,
 *            repository], calls→[service], the other four → [] (nothing).
 *   repository: NO relations table → every relation type unconstrained.
 *   gateway: present in the graph as a target type that service never lists.
 */
function makeGraph(nodes: Array<[string, string]>): Graph {
  return {
    config: {},
    architecture: {
      node_types: {
        service: {
          description: 'svc',
          relations: {
            uses: ['service', 'repository'],
            calls: ['service'],
            extends: [],
            implements: [],
            emits: [],
            listens: [],
          },
        },
        repository: { description: 'repo' },
        gateway: { description: 'gw' },
      },
    },
    nodes: new Map(nodes.map(([p, t]) => [p, node(p, t)])),
    aspects: [],
    flows: [],
    schemas: [],
    rootPath: path.join(FIXTURE_PROJECT, '.yggdrasil'),
  };
}

const viol = (fromFile: string, line: number, ownerNode: string): Violation => ({
  fromFile,
  line,
  ownerNode,
});

describe('allowedRelationTypes', () => {
  it('returns the relation types whose target list includes toType, in canonical order', () => {
    const arch = makeGraph([]).architecture;
    // service → service: uses (service ∈ [service,repository]) + calls (service ∈ [service])
    expect(allowedRelationTypes(arch, 'service', 'service')).toEqual(['uses', 'calls']);
    // service → repository: only uses (repository ∈ uses list, not in calls list)
    expect(allowedRelationTypes(arch, 'service', 'repository')).toEqual(['uses']);
  });

  it('treats a relation type ABSENT from the table as unconstrained (any target)', () => {
    const arch = makeGraph([]).architecture;
    // repository has no relations table → all six relation types are unconstrained.
    expect(allowedRelationTypes(arch, 'repository', 'service')).toEqual([
      'uses',
      'calls',
      'extends',
      'implements',
      'emits',
      'listens',
    ]);
  });

  it('returns [] (dead-end) when every present relation type excludes toType', () => {
    const arch = makeGraph([]).architecture;
    // service constrains all six relation types; none lists gateway → dead-end.
    expect(allowedRelationTypes(arch, 'service', 'gateway')).toEqual([]);
  });

  it('returns [] for an unknown fromType', () => {
    const arch = makeGraph([]).architecture;
    expect(allowedRelationTypes(arch, 'nope', 'service')).toEqual([]);
  });
});

describe('relationRefusedMessage', () => {
  it('names the exact yg-node.yaml path to edit', () => {
    const graph = makeGraph([
      ['a', 'service'],
      ['b', 'service'],
    ]);
    const m = relationRefusedMessage(graph, 'a', [viol('src/a/foo.ts', 3, 'b')]);
    expect(m.next).toContain('.yggdrasil/model/a/yg-node.yaml');
    // what block enumerates the violating site.
    expect(m.what).toContain('src/a/foo.ts:3 → b');
    expect(m.why).toContain('sanctioned, declared relation');
  });

  it('lists the allowed relation types for a permitted (type→type) pair and shows the stanza', () => {
    const graph = makeGraph([
      ['a', 'service'],
      ['b', 'repository'],
    ]);
    const m = relationRefusedMessage(graph, 'a', [viol('src/a/foo.ts', 1, 'b')]);
    // service → repository allows only `uses`.
    expect(m.next).toContain('allowed relation type(s) [uses]');
    expect(m.next).toContain('relations:');
    expect(m.next).toContain('- target: b');
    expect(m.next).toContain('type: uses');
  });

  it('emits the dead-end wording when no relation type is allowed between the node types', () => {
    const graph = makeGraph([
      ['a', 'service'],
      ['g', 'gateway'],
    ]);
    const m = relationRefusedMessage(graph, 'a', [viol('src/a/foo.ts', 9, 'g')]);
    expect(m.next).toContain('no relation type is allowed from service to gateway');
    expect(m.next).toContain('.yggdrasil/yg-architecture.yaml');
    expect(m.next).toContain('requires confirming the architecture change');
    // No stanza for a dead-end.
    expect(m.next).not.toContain('- target: g');
  });

  it('falls back to (unknown type) wording when a target node is not in the graph', () => {
    // The violation names a target node 'ghost' that the graph does not contain
    // → its type is unknown → the message cannot compute an allow-list and emits
    // the dead-end note with the (unknown type) placeholder for the target.
    const graph = makeGraph([['a', 'service']]);
    const m = relationRefusedMessage(graph, 'a', [viol('src/a/foo.ts', 2, 'ghost')]);
    expect(m.next).toContain('no relation type is allowed from service to (unknown type)');
    expect(m.next).not.toContain('- target: ghost');
  });

  it('deduplicates repeated targets into a single stanza but keeps all sites', () => {
    const graph = makeGraph([
      ['a', 'service'],
      ['b', 'service'],
    ]);
    const m = relationRefusedMessage(graph, 'a', [
      viol('src/a/foo.ts', 1, 'b'),
      viol('src/a/bar.ts', 4, 'b'),
    ]);
    expect(m.what).toContain('src/a/foo.ts:1 → b');
    expect(m.what).toContain('src/a/bar.ts:4 → b');
    // Only one stanza block for target b (allowed: uses, calls).
    expect(m.next.match(/- target: b/g)?.length).toBe(1);
    expect(m.next).toContain('allowed relation type(s) [uses, calls]');
  });
});

describe('relationUnverifiedMessage', () => {
  it('points at yg check --approve', () => {
    const m = relationUnverifiedMessage('a');
    expect(m.what).toContain("node 'a' is unverified");
    expect(m.next).toContain('yg check --approve');
  });
});
