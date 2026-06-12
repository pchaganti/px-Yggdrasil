// Goldens pin that runStructureAspect records result-bearing observations alongside
// the existing touchedFiles mechanism. A cached deterministic verdict is only
// reusable when every probe the check made (reads, listings, existence checks, graph
// node accesses) returned the same value — so the runner records WHAT each probe
// returned, not just which paths were visited.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runStructureAspect } from '../../../src/structure/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import {
  observationKey,
  hashReadObservation,
  hashListObservation,
  hashExistsObservation,
} from '../../../src/core/pair-hash.js';
import { ObservationRecorder } from '../../../src/structure/observations.js';

describe('ObservationRecorder — unit', () => {
  it('tainted=false in clean run with no conflicts', () => {
    const rec = new ObservationRecorder();
    rec.recordRead('src/a.ts', Buffer.from('hello'));
    rec.recordExists('src/b.ts', 'file');
    rec.recordList('src/', [{ name: 'a.ts', kind: 'file' }]);
    expect(rec.tainted).toBe(false);
  });

  it('dedup — same key same hash → one entry', () => {
    const rec = new ObservationRecorder();
    rec.recordRead('src/a.ts', Buffer.from('hello'));
    rec.recordRead('src/a.ts', Buffer.from('hello'));
    const snap = rec.snapshot();
    const readEntries = snap.filter(([k]) => k.startsWith('read:src/a.ts'));
    expect(readEntries).toHaveLength(1);
  });

  it('sorted output — keys come back in code-point order', () => {
    const rec = new ObservationRecorder();
    rec.recordExists('z.ts', 'file');
    rec.recordExists('a.ts', false);
    rec.recordRead('m.ts', Buffer.from('x'));
    const snap = rec.snapshot();
    const keys = snap.map(([k]) => k);
    expect(keys).toEqual([...keys].sort());
  });

  it('taint: same key different hash → tainted=true, first hash wins', () => {
    const rec = new ObservationRecorder();
    const buf1 = Buffer.from('first');
    const buf2 = Buffer.from('second');
    rec.recordRead('src/a.ts', buf1);
    rec.recordRead('src/a.ts', buf2);
    expect(rec.tainted).toBe(true);
    const snap = rec.snapshot();
    const entry = snap.find(([k]) => k === observationKey('read', 'src/a.ts'));
    // First hash wins
    expect(entry?.[1]).toBe(hashReadObservation(buf1));
  });

  it('no taint for distinct keys with distinct hashes', () => {
    const rec = new ObservationRecorder();
    rec.recordRead('src/a.ts', Buffer.from('aaa'));
    rec.recordRead('src/b.ts', Buffer.from('bbb'));
    expect(rec.tainted).toBe(false);
  });
});

describe('runStructureAspect — observation recording', () => {
  let projectRoot: string;
  let cbCounter = 0;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-obs-test-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const x = 1;');
    writeFileSync(path.join(projectRoot, 'src/b.ts'), 'export const y = 2;');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  async function writeAspect(aspectId: string, checkBody: string): Promise<string> {
    cbCounter += 1;
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'check.mjs'), `// cb=${cbCounter}\n${checkBody}`);
    return aspectDir;
  }

  it('out-of-subject fs.read → read: key with correct hash', async () => {
    // src/b.ts is NOT in the node mapping (which is only src/a.ts), so reading it
    // via ctx.fs.read is an out-of-subject operation and must record a read: observation.
    await writeAspect('obs-read', `
      export function check(ctx) {
        ctx.fs.read('src/b.ts');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-read'),
      aspectId: 'obs-read', nodePath: 'N', graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    const expectedKey = observationKey('read', 'src/b.ts');
    const expectedHash = hashReadObservation(Buffer.from('export const y = 2;'));
    const entry = r.observations.find(([k]) => k === expectedKey);
    expect(entry).toBeDefined();
    expect(entry![1]).toBe(expectedHash);
    expect(r.observationsTainted).toBe(false);
  });

  it('fs.list → list: key whose hash changes when a file is added', async () => {
    // First run: list src/ with only a.ts and b.ts
    await writeAspect('obs-list', `
      export function check(ctx) {
        ctx.fs.list('src');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });

    const r1 = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-list'),
      aspectId: 'obs-list', nodePath: 'N', graph: g, projectRoot,
    });
    const listKey = observationKey('list', 'src');
    const entry1 = r1.observations.find(([k]) => k === listKey);
    expect(entry1).toBeDefined();

    // Add a file to src/ and run again — the hash must change
    writeFileSync(path.join(projectRoot, 'src', 'c.ts'), 'export const z = 3;');
    const r2 = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-list'),
      aspectId: 'obs-list', nodePath: 'N', graph: g, projectRoot,
    });
    const entry2 = r2.observations.find(([k]) => k === listKey);
    expect(entry2).toBeDefined();
    // Hash changed because directory contents changed
    expect(entry1![1]).not.toBe(entry2![1]);
  });

  it('NEGATIVE fs.exists probe → exists: key with hash of "false" token', async () => {
    // src/missing.ts is declared in the relation target mapping but does not exist
    // on disk — the exists() probe returns false and must record it as an observation.
    // We declare it in the mapping so the allowedSet admits the path.
    await writeAspect('obs-exists-false', `
      export function check(ctx) {
        ctx.fs.exists('src/missing.ts');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/missing.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-exists-false'),
      aspectId: 'obs-exists-false', nodePath: 'N', graph: g, projectRoot,
    });
    const existsKey = observationKey('exists', 'src/missing.ts');
    const entry = r.observations.find(([k]) => k === existsKey);
    expect(entry).toBeDefined();
    expect(entry![1]).toBe(hashExistsObservation(false));
  });

  it('positive fs.exists → exists: key with hash of "file" token', async () => {
    // src/b.ts exists on disk and is accessible via a relation — the exists()
    // probe returns 'file' and must record that result as an observation.
    // src/a.ts is a subject file and must NOT produce an observation even if checked.
    await writeAspect('obs-exists-file', `
      export function check(ctx) {
        ctx.fs.exists('src/b.ts');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-exists-file'),
      aspectId: 'obs-exists-file', nodePath: 'N', graph: g, projectRoot,
    });
    // src/b.ts is an out-of-subject file — must be recorded as 'file'
    const existsKey = observationKey('exists', 'src/b.ts');
    const entry = r.observations.find(([k]) => k === existsKey);
    expect(entry).toBeDefined();
    expect(entry![1]).toBe(hashExistsObservation('file'));
    expect(r.observationsTainted).toBe(false);
  });

  it('ctx.graph.node() → graph: key for the accessed node', async () => {
    // The current node itself is accessible via ctx.graph.node(). Its yaml bytes
    // must be recorded as a graph: observation.
    await writeAspect('obs-graph-node', `
      export function check(ctx) {
        ctx.graph.node(ctx.node.id);
        return [];
      }
    `);
    // Create the yg-node.yaml that ctx-graph will look up
    const modelDir = path.join(projectRoot, '.yggdrasil', 'model', 'N');
    mkdirSync(modelDir, { recursive: true });
    const nodeYaml = 'name: N\ntype: module\nmapping:\n  - src/a.ts\n';
    writeFileSync(path.join(modelDir, 'yg-node.yaml'), nodeYaml);

    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-graph-node'),
      aspectId: 'obs-graph-node', nodePath: 'N', graph: g, projectRoot,
    });
    const graphKey = observationKey('graph', 'N');
    const entry = r.observations.find(([k]) => k === graphKey);
    expect(entry).toBeDefined();
    // The graph node in our test has no nodeYamlRaw (minimal graph stub) so the
    // recorder falls back to reading the file from disk — verify the hash matches.
    expect(entry![1]).toBe(hashReadObservation(Buffer.from(nodeYaml)));
  });

  it('nodesByType returning N nodes → N graph: observations', async () => {
    await writeAspect('obs-nodes-by-type', `
      export function check(ctx) {
        ctx.graph.nodesByType('module');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-nodes-by-type'),
      aspectId: 'obs-nodes-by-type', nodePath: 'N', graph: g, projectRoot,
    });
    // Both N and Dep are type 'module' and in the allowed set (via relation)
    const graphObs = r.observations.filter(([k]) => k.startsWith('graph:'));
    expect(graphObs.length).toBeGreaterThanOrEqual(2);
    const keys = graphObs.map(([k]) => k);
    expect(keys).toContain(observationKey('graph', 'N'));
    expect(keys).toContain(observationKey('graph', 'Dep'));
  });

  it('subject-file read NOT duplicated as observation', async () => {
    // src/a.ts is in the node mapping (subject file) — reading it via ctx.fs.read
    // must NOT produce a read: observation since it is already hashed as a subject input.
    await writeAspect('obs-subject-skip', `
      export function check(ctx) {
        ctx.fs.read('src/a.ts');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-subject-skip'),
      aspectId: 'obs-subject-skip', nodePath: 'N', graph: g, projectRoot,
    });
    const readKey = observationKey('read', 'src/a.ts');
    const entry = r.observations.find(([k]) => k === readKey);
    expect(entry).toBeUndefined();
  });

  it('snapshot is sorted in code-point order', async () => {
    await writeAspect('obs-sort', `
      export function check(ctx) {
        ctx.fs.exists('src/nonexistent.ts');
        ctx.fs.read('src/b.ts');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-sort'),
      aspectId: 'obs-sort', nodePath: 'N', graph: g, projectRoot,
    });
    const keys = r.observations.map(([k]) => k);
    expect(keys).toEqual([...keys].sort());
    expect(r.observationsTainted).toBe(false);
  });

  it('tainted=false in clean multi-observation run', async () => {
    await writeAspect('obs-notainted', `
      export function check(ctx) {
        ctx.fs.exists('src/b.ts');
        ctx.fs.read('src/b.ts');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-notainted'),
      aspectId: 'obs-notainted', nodePath: 'N', graph: g, projectRoot,
    });
    expect(r.observationsTainted).toBe(false);
  });

  it('tainted=true when same key observed with different hashes (simulated via recorder)', () => {
    // We can only simulate a mid-run content change by directly calling the recorder,
    // since check.mjs cannot perform writes. This validates the first-hash-wins contract.
    const rec = new ObservationRecorder();
    const buf1 = Buffer.from('version A');
    const buf2 = Buffer.from('version B');
    rec.recordRead('src/shared.ts', buf1);
    rec.recordRead('src/shared.ts', buf2);
    expect(rec.tainted).toBe(true);
    const snap = rec.snapshot();
    const entry = snap.find(([k]) => k === observationKey('read', 'src/shared.ts'));
    // First-hash-wins
    expect(entry?.[1]).toBe(hashReadObservation(buf1));
  });

  it('positive exists: hash differs from negative exists: hash', () => {
    // The three outcomes ('file', 'dir', false) must produce distinct hashes.
    const fileHash = hashExistsObservation('file');
    const dirHash = hashExistsObservation('dir');
    const falseHash = hashExistsObservation(false);
    expect(fileHash).not.toBe(dirHash);
    expect(fileHash).not.toBe(falseHash);
    expect(dirHash).not.toBe(falseHash);
  });
});
