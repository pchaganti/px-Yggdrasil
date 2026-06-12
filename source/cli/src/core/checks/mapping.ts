import path from 'node:path';
import type { Graph, AspectStatus } from '../../model/graph.js';
import type { ValidationIssue } from '../../model/validation.js';
import { normalizeMappingPaths } from '../../io/paths.js';
import { expandMappingPaths } from '../../io/hash.js';
import { mappingEntryMatchesFile, isGlobPattern } from '../../utils/mapping-path.js';
import { readSortedDir, statPath, fileAccess } from '../../io/graph-fs.js';
import { walkRepoFiles } from '../../io/repo-scanner.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from '../graph/aspects.js';
import { FileContentCache } from '../../io/file-content-cache.js';
import { evaluateFileWhen } from '../file-when-evaluator.js';
import { renderTrace } from '../../formatters/predicate-trace.js';
import { issueMsg } from './shared.js';
import { toPosixPath } from '../../utils/posix.js';
import { BINARY_EXTENSIONS } from '../../utils/binary-extensions.js';

export async function checkFileMappingGitignored(graph: Graph): Promise<ValidationIssue[]> {
  const projectRoot = path.dirname(graph.rootPath);
  const tracked = new Set(await walkRepoFiles(projectRoot));
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const mapping = node.meta.mapping ?? [];
    for (const relPath of mapping) {
      const absPath = path.join(projectRoot, relPath);
      let st;
      try { st = await statPath(absPath); } catch { continue; }
      if (!st.isFile()) continue;
      if (tracked.has(relPath)) continue;
      issues.push({
        severity: 'error',
        code: 'file-mapping-gitignored',
        rule: 'file-mapping-gitignored',
        nodePath,
        ...issueMsg({
          what: `File '${normalizePathForCompare(relPath)}' is in mapping of node '${nodePath}' but is excluded by .gitignore.`,
          why: `Mappings cannot contain .gitignored files — strict backward scan skips them, creating a gap where agent-created files matching a strict type's when could evade enforcement.`,
          next: `Either:\n  1. Remove the file from .gitignore (if it should be tracked code).\n  2. Remove the file from the mapping (if it's a generated artifact).`,
        }),
      });
    }
  }
  return issues;
}
export function checkFileDuplicateMapping(_graph: Graph): ValidationIssue[] { return []; }
export async function checkStrictBackwardCoverage(
  graph: Graph,
  cache: FileContentCache,
): Promise<{ issues: ValidationIssue[]; unreadable: ValidationIssue[] }> {
  const strictTypes = Object.entries(graph.architecture.node_types).filter(
    ([, def]) => def.enforce === 'strict' && def.when !== undefined,
  );
  if (strictTypes.length === 0) return { issues: [], unreadable: [] };

  const projectRoot = path.dirname(graph.rootPath);

  const repoFiles = await walkRepoFiles(projectRoot);
  const issues: ValidationIssue[] = [];
  const unreadable: ValidationIssue[] = [];
  const overlapPairsSeen = new Set<string>();

  for (const rawRel of repoFiles) {
    // walkRepoFiles already POSIX-normalizes, but re-apply the canonical normalization
    // defensively so every repo-relative path written into an output message below is
    // provably POSIX (no backslash, no trailing slash) regardless of the scanner's
    // contract. Idempotent on already-clean paths, so file-owner lookups are unaffected.
    const relPath = normalizePathForCompare(rawRel);
    const absPath = path.join(projectRoot, relPath);

    // Evaluate each strict type's when against this file.
    const matchingTypes: Array<{ typeId: string; trace: string }> = [];
    let fileSkipped = false;

    for (const [typeId, def] of strictTypes) {
      const result = await evaluateFileWhen(def.when!, {
        absPath,
        repoRelPath: relPath,
        projectRoot,
        cache,
      });

      if (result.unreadable) {
        unreadable.push({
          severity: 'error',
          code: 'file-unreadable',
          rule: 'file-unreadable',
          ...issueMsg({
            what: `Validator could not read '${relPath}' during strict backward scan.\nOS error: ${result.unreadableReason ?? 'unknown'}`,
            why: `Strict enforcement of type '${typeId}' requires reading file content. Files that cannot be opened cannot be classified.`,
            next: `Fix file permissions, or add to .gitignore if it's a generated artifact.`,
          }),
        });
        fileSkipped = true;
        break;
      }

      if (result.result) matchingTypes.push({ typeId, trace: renderTrace(result.trace, '  ') });
    }

    if (fileSkipped) continue;

    if (matchingTypes.length > 1) {
      // Two or more strict types claim this file — conflicting architecture.
      const sorted = matchingTypes.map((m) => m.typeId).sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const key = `${sorted[i]}|${sorted[j]}`;
          if (overlapPairsSeen.has(key)) continue;
          overlapPairsSeen.add(key);
          issues.push({
            severity: 'error',
            code: 'strict-overlap-conflict',
            rule: 'strict-overlap-conflict',
            ...issueMsg({
              what: `Two types with enforce: strict have overlapping when predicates:\n  '${sorted[i]}'.when matches\n  '${sorted[j]}'.when matches\nExample matching file: '${relPath}'`,
              why: `Both types declare enforce: strict — each demands that any matching file be owned by a node of its type. With the one-owner rule, satisfying both simultaneously is impossible.`,
              next: `Narrow one of the when predicates so they cannot both match the same file.\nRun: yg impact --type ${sorted[i]}\nRun: yg impact --type ${sorted[j]}`,
            }),
          });
        }
      }
      continue; // Conflict supersedes orphan/misplaced for this file.
    }

    if (matchingTypes.length === 0) continue;

    const { typeId, trace } = matchingTypes[0];
    // Glob-aware owner resolution: first node (graph insertion order = first-owner-wins)
    // whose mapping has an entry matching this file.
    let owner: { nodePath: string; nodeType: string } | undefined;
    for (const [nodePath, node] of graph.nodes) {
      const entries = node.meta.mapping ?? [];
      if (entries.some((entry) => mappingEntryMatchesFile(entry, relPath))) {
        owner = { nodePath, nodeType: node.meta.type };
        break;
      }
    }
    if (owner === undefined) {
      issues.push({
        severity: 'error',
        code: 'type-strict-orphan',
        rule: 'type-strict-orphan',
        ...issueMsg({
          what: `File '${relPath}' satisfies when of type '${typeId}' (enforce: strict):\n${trace}\nBut file is not in any node's mapping.`,
          why: `Type '${typeId}' has enforce: strict — every file satisfying its when must belong to a mapping of a node of type '${typeId}'. Otherwise the file looks like a ${typeId} but bypasses ${typeId}-level enforcement.`,
          next: `Create yg-node.yaml with type: ${typeId} and add '${relPath}' to its mapping.`,
        }),
      });
    } else if (owner.nodeType !== typeId) {
      issues.push({
        severity: 'error',
        code: 'type-strict-misplaced',
        rule: 'type-strict-misplaced',
        nodePath: owner.nodePath,
        ...issueMsg({
          what: `File '${relPath}' satisfies when of type '${typeId}' (enforce: strict):\n${trace}\nBut is in mapping of node '${owner.nodePath}' (type: ${owner.nodeType}).`,
          why: `Type '${typeId}' has enforce: strict — every file satisfying its when must be owned by a node of type '${typeId}'. Current owner has wrong type.`,
          next: `Options:\n  1. Move mapping entry to a ${typeId}-type node.\n  2. Refactor file so it no longer matches ${typeId}.when.\n  3. Change '${owner.nodePath}' type to '${typeId}' if conceptually correct.`,
        }),
      });
    }
  }
  return { issues, unreadable };
}

// --- Rule 5: Mapping ownership overlap ---

function normalizePathForCompare(mappingPath: string): string {
  return toPosixPath(mappingPath.trim());
}

function arePathsOverlapping(pathA: string, pathB: string): boolean {
  if (pathA === pathB) return true;
  return pathA.startsWith(pathB + '/') || pathB.startsWith(pathA + '/');
}

function isAncestorNode(possibleAncestor: string, possibleDescendant: string): boolean {
  return possibleDescendant.startsWith(possibleAncestor + '/');
}

export async function checkMappingOverlap(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const ownership: Array<{ nodePath: string; mappingPath: string }> = [];

  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping)
      .map(normalizePathForCompare)
      .filter((mappingPath) => mappingPath.length > 0);
    for (const mappingPath of mappingPaths) {
      ownership.push({ nodePath, mappingPath });
    }
  }

  for (let index = 0; index < ownership.length; index++) {
    const current = ownership[index];
    for (let nestedIndex = index + 1; nestedIndex < ownership.length; nestedIndex++) {
      const candidate = ownership[nestedIndex];
      if (current.nodePath === candidate.nodePath) continue;
      if (!arePathsOverlapping(current.mappingPath, candidate.mappingPath)) continue;

      if (current.mappingPath === candidate.mappingPath) {
        issues.push({
          severity: 'error',
          code: 'file-duplicate-mapping',
          rule: 'file-duplicate-mapping',
          nodePath: candidate.nodePath,
          ...issueMsg({
            what: `File '${current.mappingPath}' appears in mappings of multiple nodes:\n  ${current.nodePath}\n  ${candidate.nodePath}`,
            why: `Each source file must have exactly one owner node. Duplicate mappings lead to ambiguous classification and conflicting aspect attribution.`,
            next: `Remove the file from one of the mappings. Decide which node logically owns the file based on its primary role. The other node should reference it via relations if needed.`,
          }),
        });
        continue;
      }

      // Allow containment overlaps between ancestor-descendant nodes ("child wins" model).
      const isHierarchical =
        isAncestorNode(current.nodePath, candidate.nodePath) ||
        isAncestorNode(candidate.nodePath, current.nodePath);

      if (isHierarchical) continue;

      issues.push({
        severity: 'error',
        code: 'overlapping-mapping',
        rule: 'overlapping-mapping',
        ...issueMsg({
          what: `Mapping paths '${current.mappingPath}' (${current.nodePath}) and '${candidate.mappingPath}' (${candidate.nodePath}) overlap.`,
          why: `Each source file must have exactly one owner node.`,
          next: `Keep one owner mapping and model other concerns via relations.`,
        }),
        nodePath: candidate.nodePath,
      });
    }
  }

  // Glob-aware file-level overlap: the pairwise string check above compares
  // mapping ENTRIES literally, so it cannot see that a glob entry in one node
  // and any entry in another resolve to the SAME file. Resolve every node's
  // mappings to concrete files and flag any file owned by two non-hierarchical
  // nodes (child-wins still allows an ancestor↔descendant pair). Gated on the
  // presence of at least one glob entry so glob-free graphs pay nothing here and
  // their plain↔plain overlaps stay solely on the (already-tested) string pass.
  const anyGlob = [...graph.nodes.values()].some((n) =>
    (n.meta.mapping ?? []).some((e) => isGlobPattern(e)),
  );
  if (anyGlob) {
    const projectRoot = path.dirname(graph.rootPath);
    const repoFiles = await walkRepoFiles(projectRoot);
    const reported = new Set<string>();
    for (const rawRel of repoFiles) {
      const relPath = normalizePathForCompare(rawRel);
      const owners: string[] = [];
      let viaGlob = false;
      for (const [nodePath, node] of graph.nodes) {
        let matched = false;
        for (const entry of node.meta.mapping ?? []) {
          if (!mappingEntryMatchesFile(entry, relPath)) continue;
          matched = true;
          if (isGlobPattern(entry)) viaGlob = true;
        }
        if (matched) owners.push(nodePath);
      }
      // Only the glob pass's job: plain↔plain overlaps are handled above.
      if (owners.length < 2 || !viaGlob || reported.has(relPath)) continue;
      // Child-wins: drop owners that are an ancestor of another owner; an
      // ambiguous file is one with two or more remaining (sibling/unrelated) owners.
      const leaves = owners.filter(
        (o) => !owners.some((other) => other !== o && isAncestorNode(o, other)),
      );
      if (leaves.length < 2) continue;
      reported.add(relPath);
      issues.push({
        severity: 'error',
        code: 'overlapping-mapping',
        rule: 'overlapping-mapping',
        ...issueMsg({
          what: `File '${relPath}' is owned by multiple non-hierarchical nodes:\n${leaves.map((n) => '  ' + n).join('\n')}`,
          why: `Each source file must have exactly one owner node. A glob mapping in one node resolves to a file also claimed by another node.`,
          next: `Narrow the glob, or remove the file from one node's mapping and model the dependency via a relation.`,
        }),
        nodePath: leaves[0],
      });
    }
  }

  return issues;
}

// --- Rule: Mapping paths should exist on disk (mapping-path-missing) ---

export async function checkMappingPathsExist(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);
  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping).map(normalizePathForCompare);
    for (const mp of mappingPaths) {
      if (isGlobPattern(mp)) {
        // For glob entries: verify that at least one file matches.
        const matched = await expandMappingPaths(projectRoot, [mp]);
        if (matched.length === 0) {
          issues.push({
            severity: 'error',
            code: 'mapping-path-missing',
            rule: 'mapping-path-missing',
            ...issueMsg({
              what: `Glob '${mp}' matches no files on disk.`,
              why: `Node maps a glob pattern that currently resolves to no files — possibly all matching files were deleted or the pattern is wrong.`,
              next: `Update mapping in yg-node.yaml: fix the glob or remove the entry.`,
            }),
            nodePath,
          });
        }
      } else {
        const absPath = path.join(projectRoot, mp);
        try {
          await fileAccess(absPath);
        } catch {
          issues.push({
            severity: 'error',
            code: 'mapping-path-missing',
            rule: 'mapping-path-missing',
            ...issueMsg({
              what: `Mapping path '${mp}' does not exist on disk.`,
              why: `Node maps a file that was deleted or moved.`,
              next: `Update mapping in yg-node.yaml: fix the path or remove the entry.`,
            }),
            nodePath,
          });
        }
      }
    }
  }
  return issues;
}

// --- mapping-escapes-repo: a mapping entry resolves outside the repo root ---

/**
 * Reject mapping entries that are absolute or climb above the repository root
 * with `..`. normalizeMappingPath only converts separators and strips a leading
 * `./` and trailing slashes — it does NOT collapse `..`, so a mapping like
 * `../../etc/passwd` would otherwise be resolved against the project root and let
 * a node claim files outside the repository, bypassing coverage and enforcement.
 */
export function checkMappingEscapesRepo(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);
  for (const [nodePath, node] of graph.nodes) {
    for (const raw of node.meta.mapping ?? []) {
      const norm = normalizePathForCompare(raw);
      const resolved = path.resolve(projectRoot, norm);
      const rel = normalizePathForCompare(path.relative(projectRoot, resolved));
      if (path.isAbsolute(norm) || rel === '..' || rel.startsWith('../')) {
        issues.push({
          severity: 'error',
          code: 'mapping-escapes-repo',
          rule: 'mapping-escapes-repo',
          nodePath,
          ...issueMsg({
            what: `Mapping path '${norm}' in node '${nodePath}' resolves outside the repository root.`,
            why: `A mapping must point to a file inside the repo. An absolute path, or one that climbs above the root with '..', would let a node claim files outside the project — bypassing coverage and aspect enforcement.`,
            next: `Make the mapping repo-relative and within the project: no leading '/', and no '..' segment that climbs above the root.`,
          }),
        });
      }
    }
  }
  return issues;
}

// --- oversized-node: Node maps more than the per-node character budget ---

/**
 * A node's reviewer context is its mapped source files plus the reference files
 * of every effective aspect — all concatenated into the per-aspect prompt. When
 * that total exceeds the budget the prompt risks context-window truncation,
 * which produces deterministic false rejections of unchanged code near the cut.
 * This is a blocking error: the node must be split (or, for an unsplittable
 * generated/binary artifact, carry a documented `sizeExempt` opt-out).
 *
 * The budget applies ONLY to nodes that are actually sent to an LLM reviewer —
 * i.e. a node with at least one effective LLM aspect whose effective status is
 * non-draft (advisory/enforced). That is the only place a node's files are
 * concatenated into a single context-window-bounded prompt. Deterministic
 * aspects (`check.mjs`) read files programmatically with no window, and
 * aspect-less / draft-only nodes are never reviewed, so none of them is bounded
 * — the budget would be a false constraint there. Note this makes the gate
 * cascade-sensitive: adding an LLM aspect via a type default / flow / port /
 * implies can newly bring a previously-unbounded node under the budget.
 * Binary files contribute nothing.
 */
export async function checkOversizedNodes(
  graph: Graph,
  cache: FileContentCache,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const maxChars = graph.config.quality?.max_node_chars ?? 40000;
  const projectRoot = path.dirname(graph.rootPath);

  // aspect id -> its reference file paths (repo-root-relative)
  const refsByAspect = new Map<string, string[]>();
  for (const aspect of graph.aspects) {
    if (aspect.references?.length) {
      refsByAspect.set(aspect.id, aspect.references.map((r) => r.path));
    }
  }
  const aspectById = new Map(graph.aspects.map((a) => [a.id, a]));

  async function charsOf(repoRelPath: string): Promise<number> {
    if (BINARY_EXTENSIONS.has(path.extname(repoRelPath).toLowerCase())) return 0;
    const abs = path.resolve(projectRoot, repoRelPath);
    const res = await cache.read(abs);
    if (res.content !== undefined) return res.content.length;
    // No content: binary (NUL bytes), unreadable, or over the cache's 5MB limit.
    // A non-binary file over 5MB is almost certainly oversized text the gate must
    // catch — the cache skips reading it as a binary-probe optimization, not a
    // budget exemption — so fall back to its on-disk byte size as a character proxy.
    if (res.tooLarge) {
      try {
        return (await statPath(abs)).size;
      } catch {
        return 0;
      }
    }
    return 0; // binary content or unreadable
  }

  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.sizeExempt) continue; // documented opt-out (justification required at parse)
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    if (mappingPaths.length === 0) continue;

    const sourceFiles = await expandMappingPaths(projectRoot, mappingPaths);

    // distinct reference files pulled in by this node's effective aspects. An
    // aspect-implies cycle makes computeEffectiveAspects throw; that cycle is
    // reported by checkImpliesNoCycles, so skip the reference contribution here
    // rather than crash the whole validation run with a raw stack trace.
    let effectiveAspects: Set<string>;
    try {
      effectiveAspects = computeEffectiveAspects(node, graph);
    } catch {
      effectiveAspects = new Set();
    }

    // Budget applies only to LLM-reviewed nodes (see fn docstring): at least one
    // effective LLM aspect with a non-draft effective status. Otherwise no prompt
    // is built from this node's files, so there is no context window to protect.
    let statuses: Map<string, AspectStatus>;
    try {
      statuses = computeEffectiveAspectStatuses(node, graph);
    } catch {
      statuses = new Map();
    }
    const isLlmReviewed = [...effectiveAspects].some((id) => {
      const def = aspectById.get(id);
      return def?.reviewer.type === 'llm' && (statuses.get(id) ?? 'enforced') !== 'draft';
    });
    if (!isLlmReviewed) continue;

    const refPaths = new Set<string>();
    for (const aspectId of effectiveAspects) {
      for (const rp of refsByAspect.get(aspectId) ?? []) refPaths.add(rp);
    }

    let total = 0;
    for (const f of sourceFiles) total += await charsOf(f);
    for (const rp of refPaths) total += await charsOf(rp);

    if (total <= maxChars) continue;

    issues.push({
      severity: 'error',
      code: 'oversized-node',
      rule: 'oversized-node',
      ...issueMsg({
        what: `Node's reviewer context is ${total} characters (max: ${maxChars}).`,
        why: `Oversized nodes risk context-window truncation — the reviewer verifies every aspect against all mapped source plus reference files at once, and a prompt larger than the window deterministically rejects unchanged code near the cut. Smaller nodes also keep reviewer focus sharp.`,
        next: `Split into child nodes so each maps under ${maxChars} characters; group files by the aspects that apply to them. If this node maps a single unsplittable generated or binary artifact, add 'sizeExempt: { reason: "<why it cannot be split>" }' to its yg-node.yaml.`,
      }),
      nodePath,
    });
  }
  return issues;
}

// --- Directories have yg-node.yaml ---

export async function checkDirectoriesHaveNodeYaml(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const modelDir = path.join(graph.rootPath, 'model');

  async function scanDir(dirPath: string, segments: string[]): Promise<void> {
    const entries = await readSortedDir(dirPath);
    const hasNodeYaml = entries.some((e) => e.isFile() && e.name === 'yg-node.yaml');

    const hasFiles = entries.some((e) => e.isFile());
    const graphPath = segments.join('/');

    if (!hasNodeYaml && graphPath !== '') {
      if (hasFiles) {
        issues.push({
          severity: 'error',
          code: 'node-yaml-missing',
          rule: 'missing-node-yaml',
          ...issueMsg({
            what: `Directory '${graphPath}' has files but no yg-node.yaml.`,
            why: `Every directory in model/ must have a node definition.`,
            next: `Create yg-node.yaml in ${graphPath} or move files to an existing node directory.`,
          }),
          nodePath: graphPath,
        });
      }
      // directory-without-node covered by unmapped-files check
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      await scanDir(path.join(dirPath, entry.name), [...segments, entry.name]);
    }
  }

  try {
    const rootEntries = await readSortedDir(modelDir);
    for (const entry of rootEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      await scanDir(path.join(modelDir, entry.name), [entry.name]);
    }
  } catch {
    // model/ may not exist
  }

  return issues;
}
