import path from 'node:path';
import type { Graph } from '../../model/graph.js';
import type { ValidationIssue } from '../../model/validation.js';
import { normalizeMappingPaths } from '../../io/paths.js';
import { expandMappingPaths } from '../../io/hash.js';
import { readSortedDir, statPath, fileAccess } from '../../io/graph-fs.js';
import { walkRepoFiles } from '../../io/repo-scanner.js';
import { computeEffectiveAspects } from '../graph/aspects.js';
import { FileContentCache } from '../../io/file-content-cache.js';
import { evaluateFileWhen } from '../file-when-evaluator.js';
import { renderTrace } from '../../formatters/predicate-trace.js';
import { issueMsg } from './shared.js';

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
          what: `File '${relPath}' is in mapping of node '${nodePath}' but is excluded by .gitignore.`,
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

  // Build file → first owner map
  const fileToOwner = new Map<string, { nodePath: string; nodeType: string }>();
  for (const [nodePath, node] of graph.nodes) {
    for (const relPath of node.meta.mapping ?? []) {
      if (!fileToOwner.has(relPath)) fileToOwner.set(relPath, { nodePath, nodeType: node.meta.type });
    }
  }

  const repoFiles = await walkRepoFiles(projectRoot);
  const issues: ValidationIssue[] = [];
  const unreadable: ValidationIssue[] = [];
  const overlapPairsSeen = new Set<string>();

  for (const relPath of repoFiles) {
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
    const owner = fileToOwner.get(relPath);
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
  return mappingPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function arePathsOverlapping(pathA: string, pathB: string): boolean {
  if (pathA === pathB) return true;
  return pathA.startsWith(pathB + '/') || pathB.startsWith(pathA + '/');
}

function isAncestorNode(possibleAncestor: string, possibleDescendant: string): boolean {
  return possibleDescendant.startsWith(possibleAncestor + '/');
}

export function checkMappingOverlap(graph: Graph): ValidationIssue[] {
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

  return issues;
}

// --- Rule: Mapping paths should exist on disk (mapping-path-missing) ---

export async function checkMappingPathsExist(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);
  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    for (const mp of mappingPaths) {
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
  return issues;
}

// --- wide-node: Maps too many source files ---

export async function checkWideNodes(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const maxFiles = graph.config.quality?.max_mapping_source_files ?? 10;
  const projectRoot = path.dirname(graph.rootPath);

  for (const [nodePath, node] of graph.nodes) {
    const effectiveAspects = computeEffectiveAspects(node, graph);
    if (effectiveAspects.size === 0) continue;
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    if (mappingPaths.length === 0) continue;

    const sourceFiles = await expandMappingPaths(projectRoot, mappingPaths);
    if (sourceFiles.length <= maxFiles) continue;

    issues.push({
      severity: 'warning',
      code: 'wide-node',
      rule: 'wide-node',
      ...issueMsg({
        what: `Node maps ${sourceFiles.length} source files (max: ${maxFiles}).`,
        why: `Wide nodes degrade reviewer accuracy — the reviewer verifies aspects against all source files at once. Too many files dilute focus and cause false rejections.`,
        next: `Split into child nodes with 2-5 source files each. Each child should map only the files relevant to its aspects.`,
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
            next: `Create yg-node.yaml in ${graphPath}/ or move files to an existing node directory.`,
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
