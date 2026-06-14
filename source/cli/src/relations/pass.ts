import path from 'node:path';
import { readFile } from 'node:fs/promises';

import type { Graph } from '../model/graph.js';
import { parseFile } from '../ast/parser.js';
import { getLanguageForExtension } from '../core/graph/language-registry.js';
import { ensureLoaderRegistered } from '../ast/loader-hook.js';
import { expandMappingPaths, hashString } from '../io/hash.js';

import { buildOwnerIndex } from './owner-index.js';
import {
  SymbolTable,
  loadSymbolIndex,
  writeSymbolIndex,
  type PersistedSymbolIndex,
} from './symbol-table.js';
import { makeResolver } from './resolver.js';
import { verifyNodeDeps, type ResolvedDep, type RelationGraphView, type Violation } from './verifier.js';
import type {
  DependencyExtractor,
  ParsedFile,
} from './extractors/types.js';

export interface NodeViolations {
  verdict: 'approved' | 'refused';
  reason?: string;
  violations: Violation[];
}

export interface RelationPassResult {
  violationsByNode: Map<string, NodeViolations>;
} // key = nodeId (node.path)

export interface RelationPassDeps {
  extractorFor: (language: string) => DependencyExtractor | undefined;
  resolvePathToFile: (specifier: string, fromFile: string, language: string, isPackage?: boolean) => string | undefined;
  symbolIndexDir: string; // local cache dir, e.g. <root>/.yggdrasil/.symbols-cache
}

interface FileRecord {
  path: string; // repo-rel POSIX
  content: string;
  hash: string;
  language: string | null;
  nodeId: string;
}

export async function runRelationPass(
  graph: Graph,
  projectRoot: string,
  deps: RelationPassDeps,
): Promise<RelationPassResult> {
  // 1. Register the loader hook once so tree-sitter grammars resolve under test/dev.
  ensureLoaderRegistered();

  // 2. Enumerate every node's mapped files once; read bytes, hash, detect language.
  //    Files unreadable are skipped silently. Each file is read exactly once, so the
  //    hash captured here is reused everywhere (no re-read → the F8 taint guard is moot
  //    in a single pass; we hash at read time and never re-read the same path).
  const fileRecords: FileRecord[] = [];
  const recordByPath = new Map<string, FileRecord>();
  for (const [nodeId, node] of graph.nodes) {
    const mapping = node.meta.mapping ?? [];
    if (mapping.length === 0) continue;
    const files = await expandMappingPaths(projectRoot, mapping);
    for (const rel of files) {
      if (recordByPath.has(rel)) continue; // already enumerated under another node
      let content: string;
      try {
        content = await readFile(path.join(projectRoot, rel), 'utf-8');
      } catch {
        continue; // unreadable → skip
      }
      const language = getLanguageForExtension(path.extname(rel));
      const record: FileRecord = {
        path: rel,
        content,
        hash: hashString(content),
        language,
        nodeId,
      };
      fileRecords.push(record);
      recordByPath.set(rel, record);
    }
  }

  // 3. Owner index over the whole graph.
  const ownerIndex = buildOwnerIndex(graph.nodes);

  // Parse cache keyed by repo-rel path so step 4 and step 8 never double-parse.
  const parseCache = new Map<string, ParsedFile | null>();
  async function getParsed(record: FileRecord): Promise<ParsedFile | null> {
    if (parseCache.has(record.path)) return parseCache.get(record.path) ?? null;
    if (!record.language) {
      parseCache.set(record.path, null);
      return null;
    }
    let parsed: ParsedFile | null;
    try {
      const tree = await parseFile(record.path, record.content);
      parsed = { path: record.path, content: record.content, tree, language: record.language };
    } catch {
      // Non-parseable file → treat as having no declarations/uses. Never throw out of the pass.
      parsed = null;
    }
    parseCache.set(record.path, parsed);
    return parsed;
  }

  // 4. Build the shared SymbolTable. Universe = all mapped files of an extractor-backed
  //    language (broad universe so ambiguity is detected across the repo). Per language:
  //    try the persisted index (builtFrom-keyed); rebuild + persist on a miss.
  const symbolTable = new SymbolTable();
  const recordsByLanguage = new Map<string, FileRecord[]>();
  for (const record of fileRecords) {
    if (!record.language) continue;
    if (!deps.extractorFor(record.language)) continue;
    let list = recordsByLanguage.get(record.language);
    if (!list) {
      list = [];
      recordsByLanguage.set(record.language, list);
    }
    list.push(record);
  }

  for (const [language, records] of recordsByLanguage) {
    const extractor = deps.extractorFor(language)!;
    const builtFrom: Array<[string, string]> = records
      .map((r): [string, string] => [r.path, r.hash])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const cached = loadSymbolIndex(deps.symbolIndexDir, language, builtFrom);
    if (cached) {
      for (const [symbolKey, file] of cached.symbols) symbolTable.declare(language, symbolKey, file);
      continue;
    }

    // Cache miss → parse each file, extract declarations, accumulate, persist.
    const symbols: Array<[string, string]> = [];
    for (const record of records) {
      const parsed = await getParsed(record);
      if (!parsed) continue;
      for (const decl of extractor.declarations(parsed)) {
        symbols.push([decl.symbolKey, record.path]);
        symbolTable.declare(language, decl.symbolKey, record.path);
      }
    }
    const toPersist: PersistedSymbolIndex = { builtFrom, symbols };
    await writeSymbolIndex(deps.symbolIndexDir, language, toPersist);
  }

  // 5. Resolver composes owner index + symbol table + injected path resolution.
  const resolver = makeResolver({
    ownerIndex,
    symbolTable,
    resolvePathToFile: deps.resolvePathToFile,
  });

  // 7. Graph view for the verifier.
  const graphView: RelationGraphView = {
    isAncestorOf(a, b) {
      return b.startsWith(a + '/');
    },
    declaredTargets(nodeId) {
      return new Set((graph.nodes.get(nodeId)?.meta.relations ?? []).map((r) => r.target));
    },
    parentChain(nodeId) {
      const chain: string[] = [];
      let cur = nodeId;
      while (cur.includes('/')) {
        cur = cur.slice(0, cur.lastIndexOf('/'));
        chain.push(cur);
      }
      return chain;
    },
  };

  // 6. Per node: parse its extractor-backed files, collect detected uses, resolve
  //    each, verify undeclared cross-node dependencies, and form the LIVE result.
  const violationsByNode = new Map<string, NodeViolations>();

  for (const [nodeId] of graph.nodes) {
    const records = fileRecords.filter((r) => r.nodeId === nodeId);
    if (records.length === 0) continue; // node with NO mapped source files → no result

    const resolvedDeps: ResolvedDep[] = [];

    for (const record of records) {
      if (!record.language) continue;
      const extractor = deps.extractorFor(record.language);
      if (!extractor) continue;

      const parsed = await getParsed(record);
      if (!parsed) continue;

      for (const dep of extractor.uses(parsed)) {
        const resolved = resolver.resolve(dep.targetHint, record.path, record.language);
        if (resolved) {
          resolvedDeps.push({ fromFile: record.path, line: dep.line, ownerNode: resolved.ownerNode });
        }
      }
    }

    const violations = verifyNodeDeps(nodeId, resolvedDeps, graphView);
    if (violations.length) {
      const reason = violations
        .map((v) => `${v.fromFile}:${v.line} → undeclared dependency on ${v.ownerNode}`)
        .join('\n');
      violationsByNode.set(nodeId, { verdict: 'refused', reason, violations });
    } else {
      violationsByNode.set(nodeId, { verdict: 'approved', violations: [] });
    }
  }

  return { violationsByNode };
}
