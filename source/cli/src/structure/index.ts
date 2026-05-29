export type { Ctx, File, FsEntry, GraphNode, Port, Relation, Violation, CheckFunction, RelationType } from './types.js';
export { runStructureAspect, StructureRunnerError } from './runner.js';
// Re-export AST helpers for structure aspect authors.
// closest/walk are colocated in ast/walk.ts.
export { walk, closest } from '../ast/walk.js';
export { report } from '../ast/report.js';
export { inFile, type InFilePattern } from '../ast/file-path.js';
export { findComments, type FindCommentsTarget } from '../ast/find-comments.js';
