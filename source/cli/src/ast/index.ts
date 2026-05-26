import { report } from './report.js';
import { inFile, type InFilePattern } from './file-path.js';
import { walk, within, closest } from './walk.js';
import { findComments, type FindCommentsTarget } from './find-comments.js';
import { nameOf } from './name.js';
import { exports as exportsHelper } from './exports.js';
import { imports as importsHelper } from './imports.js';
import { call } from './call.js';
import { decoratorsOf } from './decorators.js';
import { modifiersOf } from './modifiers.js';
import { jsxElements } from './jsx.js';
import { casing } from './casing.js';

// NEW API — phase 1+
export { walk, report, inFile, findComments, closest };
export type { InFilePattern, FindCommentsTarget };
export type { Tree, Node as SyntaxNode } from 'web-tree-sitter';

// LEGACY API — preserved during transition. Deleted in Task 28.
// inFile shim accepts old string signature: /pattern/ → regex, glob meta-chars → glob,
// else substring. Imperfect heuristic but matches pre-phase-1 behavior.
export const ast = {
  report,
  nameOf,
  inFile: (file: { path: string; content: string; ast: any }, str: string): boolean => {
    if (str.length >= 2 && str.startsWith('/') && str.endsWith('/')) {
      return new RegExp(str.slice(1, -1)).test(file.path);
    }
    if (/[*?[]/.test(str)) return inFile(file as any, { glob: str });
    return inFile(file as any, { contains: str });
  },
  exports: exportsHelper,
  imports: importsHelper,
  call,
  closest,
  within,
  decoratorsOf,
  modifiersOf,
  jsxElements,
  casing,
};

export type {
  CheckContext,
  Violation,
  SourceFile,
  ExportedDecl,
  ImportInfo,
  MatchedCall,
  Decorator,
  Modifier,
  CallTarget,
} from './types.js';
