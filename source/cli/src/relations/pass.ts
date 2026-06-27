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
import { makeResolver, resolveCandidateGroup } from './resolver.js';
import { csharpUses, collectGlobalUsings, collectGlobalUsingAliases } from './extractors/csharp.js';
import { verifyNodeDeps, type ResolvedDep, type RelationGraphView, type Violation } from './verifier.js';
import type {
  DependencyExtractor,
  ParsedFile,
  DeclaredSymbol,
  DetectedDep,
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

/**
 * The pure extractor output of ONE file, produced by a SINGLE tree-sitter parse.
 * Holding these facts (not the live `Tree`) lets every phase — the symbol build, the
 * C# global-using pre-pass, and the per-node `uses()` resolution — read one file's
 * extraction without re-parsing it, while keeping WASM heap at O(1) live trees (the
 * tree is deleted inside `extractFileFacts` before the facts are returned).
 *
 * `uses` is the per-file detected dependencies for every NON-C# language. For C# it is
 * `null`: C# `uses()` folds the project-wide `global using` aggregate (built only AFTER
 * every C# file has been walked), so its `uses()` is computed LIVE per node, after the
 * pre-pass, exactly as before — a later task splits that seam. The two `csharp*` fields
 * carry that file's contribution to the project-wide global-using aggregate (empty for
 * non-C# files).
 */
interface FileFacts {
  declarations: DeclaredSymbol[];
  uses: DetectedDep[] | null; // null ⇔ C# (resolved live after the pre-pass)
  csharpGlobalUsings: string[];
  csharpGlobalUsingAliases: Array<[string, string]>;
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

  // Parse a single file, returning a ParsedFile with a live WASM tree.
  // The CALLER must call tree.delete() immediately after use — trees are never cached
  // here to keep WASM heap usage bounded to O(1) trees at any moment.
  async function parseSingle(record: FileRecord): Promise<ParsedFile | null> {
    if (!record.language) return null;
    try {
      const tree = await parseFile(record.path, record.content);
      return { path: record.path, content: record.content, tree, language: record.language };
    } catch {
      return null;
    }
  }

  // Parse a file ONCE and return its pure extractor facts. The single walk runs
  // `declarations()` (+ for non-C# `uses()`, + for C# the two global-using collectors)
  // inside ONE try/finally that ALWAYS deletes the tree — even if an extractor throws
  // mid-extraction — so a thrown extractor never leaks a WASM tree. Returns `null` iff
  // the parse itself failed or the file has no language, so callers can distinguish a
  // failed parse from a legitimately empty file (never treat a failure as empty facts).
  // The facts are then reused by the symbol build, the C# pre-pass, and per-node
  // resolution, so each file is parsed at most once here (C# pays one extra LIVE parse
  // for `uses()` after the pre-pass — see FileFacts).
  async function extractFileFacts(
    record: FileRecord,
    extractor: DependencyExtractor,
  ): Promise<FileFacts | null> {
    const parsed = await parseSingle(record);
    if (!parsed) return null;
    try {
      const declarations = extractor.declarations(parsed);
      const isCsharp = record.language === 'csharp';
      // C# `uses()` needs the project-wide global-using aggregate (built only after every
      // C# file is walked), so it is resolved LIVE per node after the pre-pass — not here.
      const uses = isCsharp ? null : extractor.uses(parsed);
      const csharpGlobalUsings = isCsharp ? collectGlobalUsings(parsed) : [];
      const csharpGlobalUsingAliases = isCsharp ? collectGlobalUsingAliases(parsed) : [];
      return { declarations, uses, csharpGlobalUsings, csharpGlobalUsingAliases };
    } finally {
      parsed.tree.delete();
    }
  }

  // 4. Single-walk extraction. Universe = all mapped files of an extractor-backed language
  //    (broad universe so ambiguity is detected across the repo). Parse each such file ONCE
  //    here (via extractFileFacts) and reuse the result for the symbol build, the C# pre-pass,
  //    and the per-node resolution below — no phase re-parses. A failed parse (null) is simply
  //    absent from factsByPath (never recorded as empty facts), exactly as the old per-phase
  //    `if (!parsed) continue;` skipped it.
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

  const factsByPath = new Map<string, FileFacts>();
  for (const record of fileRecords) {
    if (!record.language) continue;
    const extractor = deps.extractorFor(record.language);
    if (!extractor) continue;
    const facts = await extractFileFacts(record, extractor);
    if (facts) factsByPath.set(record.path, facts);
  }

  // 4a. Build the shared SymbolTable. Per language: try the persisted index (builtFrom-keyed);
  //     on a miss, declare from the already-extracted per-file facts (NO re-parse) and persist.
  //     The cache read/write is preserved verbatim from before; only the parse it used to gate
  //     is now the single walk above (so the in-memory symbol table is identical either way —
  //     decls are a pure function of the same bytes).
  for (const [language, records] of recordsByLanguage) {
    const builtFrom: Array<[string, string]> = records
      .map((r): [string, string] => [r.path, r.hash])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const cached = loadSymbolIndex(deps.symbolIndexDir, language, builtFrom);
    if (cached) {
      for (const [symbolKey, file] of cached.symbols) symbolTable.declare(language, symbolKey, file);
      continue;
    }

    // Cache miss → accumulate declarations from the single-walk facts, declare, persist.
    const symbols: Array<[string, string]> = [];
    for (const record of records) {
      const facts = factsByPath.get(record.path);
      if (!facts) continue;
      for (const decl of facts.declarations) {
        symbols.push([decl.symbolKey, record.path]);
        symbolTable.declare(language, decl.symbolKey, record.path);
      }
    }
    const toPersist: PersistedSymbolIndex = { builtFrom, symbols };
    await writeSymbolIndex(deps.symbolIndexDir, language, toPersist);
  }

  // 4.5 C# global-using pre-pass (R5). A `global using N;` declared in ANY C# file is a
  //     project-wide import that qualifies bare names in EVERY C# file. Aggregate every C#
  //     file's `global using` namespace prefixes once, then inject the set into each file's
  //     `uses()` below (as the lowest using tier). This is the one cross-file scope channel
  //     the per-file extractor cannot see on its own. Implicit/SDK global usings remain
  //     invisible to a source-only tool → the names they would import stay silenced (correct).
  //     Also aggregate every file's `global using Alias = N.Type;` project-wide aliases (A12):
  //     a global-using alias declared in ANY file is usable in EVERY file, resolved in the
  //     declaring file's context (the alias RHS is fully-qualified, so the captured FQN is the
  //     target). A later same-named global alias overwrites an earlier one (last-wins is benign:
  //     a genuine cross-file collision is a compile error C# itself rejects; our zero-FP floor is
  //     that a file-local alias of the same name always takes precedence, enforced in uses()).
  //     This now reads from the single-walk facts — NO C# re-parse — but MUST still complete
  //     (aggregate ALL C# files) BEFORE per-node resolution: a `global using` in any file
  //     changes another file's bare-name resolution, so the full aggregate is the input to
  //     every per-node C# uses() call below.
  const csharpRecords = recordsByLanguage.get('csharp') ?? [];
  const projectGlobalUsings = new Set<string>();
  const projectGlobalUsingAliases = new Map<string, string>();
  for (const record of csharpRecords) {
    const facts = factsByPath.get(record.path);
    if (!facts) continue;
    for (const prefix of facts.csharpGlobalUsings) projectGlobalUsings.add(prefix);
    for (const [name, fqn] of facts.csharpGlobalUsingAliases) projectGlobalUsingAliases.set(name, fqn);
  }
  const csharpGlobalUsings = [...projectGlobalUsings];
  const csharpGlobalUsingAliases = [...projectGlobalUsingAliases.entries()];

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

  // 6. Per node: collect detected uses (from the single-walk facts for every non-C# file;
  //    LIVE per-file for C#, which folds the project-wide global-using aggregate built above),
  //    resolve each, verify undeclared cross-node dependencies, and form the LIVE result.
  const violationsByNode = new Map<string, NodeViolations>();

  // Resolve one file's detected uses into cross-node edges (shared by both paths below).
  const resolveDetected = (record: FileRecord, detected: DetectedDep[], resolvedDeps: ResolvedDep[]): void => {
    for (const dep of detected) {
      // Ordered first-unique-match-wins walk over the candidate group — the SINGLE
      // definition shared verbatim with the reference-case runner (resolveCandidateGroup).
      // A resolved self-edge is pushed here and filtered downstream by verifyNodeDeps
      // against the node's declared relations.
      const ownerNode = resolveCandidateGroup(dep.candidates, resolver, record.path, record.language!);
      if (ownerNode !== undefined) {
        resolvedDeps.push({ fromFile: record.path, line: dep.line, ownerNode });
      }
    }
  };

  for (const [nodeId] of graph.nodes) {
    const records = fileRecords.filter((r) => r.nodeId === nodeId);
    if (records.length === 0) continue; // node with NO mapped source files → no result

    const resolvedDeps: ResolvedDep[] = [];

    for (const record of records) {
      if (!record.language) continue;
      const extractor = deps.extractorFor(record.language);
      if (!extractor) continue;

      if (record.language === 'csharp') {
        // C# uses() folds the cross-file global-using aggregate as its lowest using tier (R5),
        // so it is resolved LIVE here — one re-parse per C# file — exactly as before. A later
        // task splits this seam to source it from cached facts.
        const parsed = await parseSingle(record);
        if (!parsed) continue;
        try {
          const detected = csharpUses(parsed, {
            projectGlobalUsings: csharpGlobalUsings,
            projectGlobalUsingAliases: csharpGlobalUsingAliases,
          });
          resolveDetected(record, detected, resolvedDeps);
        } finally {
          parsed.tree.delete();
        }
        continue;
      }

      // Every non-C# file's uses() came from the single walk above (no re-parse). A file whose
      // parse failed is absent from factsByPath — skip it, exactly as `if (!parsed) continue;` did.
      const facts = factsByPath.get(record.path);
      if (!facts || facts.uses === null) continue;
      resolveDetected(record, facts.uses, resolvedDeps);
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
