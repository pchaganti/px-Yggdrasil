import { report } from './report.js';
import { nameOf } from './name.js';
import { inFile } from './file-path.js';
import { exports as exportsHelper } from './exports.js';
import { imports as importsHelper } from './imports.js';
import { call } from './call.js';
import { closest, within } from './walk.js';
import { decoratorsOf } from './decorators.js';
import { modifiersOf } from './modifiers.js';
import { jsxElements } from './jsx.js';
import { casing } from './casing.js';

export const ast = {
  report,
  nameOf,
  inFile,
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
