import { walk } from '@chrisdudek/yg/ast';

// Invariant 6 (half): every §3a navigable SURFACE has a Playwright + Chromium e2e covering it.
// The authoritative list of surfaces is the SURFACE_MANIFEST array exported from the suite's
// support/surfaces.ts (kept in lock-step with §3a A). Each spec declares which surfaces it
// covers via an exported `COVERS` string array — a stable marker. This check, per node:
//
//   1. parses SURFACE_MANIFEST from the mapped support/surfaces.ts (the source of truth);
//   2. unions every spec's exported COVERS array;
//   3. REFUSES if any manifest surface is covered by NO spec — a missing surface is the whole
//      point: adding a surface to the manifest without a covering spec blocks the build.
//
// It also refuses a COVERS id that is NOT in the manifest (a typo / stale id that silently
// covers nothing), and refuses if the manifest itself cannot be found (fail closed — never
// silently pass with an empty manifest). AST-based, scope per node: it reads the string-array
// literals from the syntax tree (an `export const X = ['a','b']`), never raw text, so a string
// that merely mentions a surface id elsewhere is not a false positive.
//
// SCOPE LIMIT — read a green here correctly. COVERS is a DECLARED surface→spec mapping, not a
// mechanical proof that the spec actually opens the surface and asserts it. This deterministic
// tripwire guarantees a covering spec EXISTS and is named for every manifest surface (no holes,
// no stale ids, never a silent empty-manifest pass) — it does NOT execute a browser and cannot
// know whether the named spec drives the right thing. The real proof that each surface is
// exercised is the live `npm run test:e2e:portal` run in repo-check.sh (real Chromium against the
// real emitted page) PLUS the e2e-public-surface aspect (the suite stays a black box over the
// shipped CLI). A green from THIS check means the coverage map has no holes; it is not a substitute
// for the live run. (Each spec keeps its COVERS adjacent to the real surface→hash navigation it
// asserts, so the declared id and the driven surface stay in lock-step by review.)

/** Pull the literal value out of a tree-sitter string / no-substitution template_string node. */
function stringValue(node) {
  if (!node) return undefined;
  if (node.type !== 'string' && node.type !== 'template_string') return undefined;
  if (node.type === 'template_string' && node.namedChildren.some((c) => c.type === 'template_substitution')) {
    return undefined;
  }
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  if (frag) return frag.text;
  const t = node.text;
  return t.length >= 2 ? t.slice(1, -1) : '';
}

/**
 * Find `export const <name> = [ ...string literals ]` (or `export const <name> = [...] as const`)
 * at the top level of a file's AST and return the array's string values. Returns null when the
 * named export is absent, or [] when it is present but empty. The array may appear directly as the
 * declarator value or wrapped in an `as const` assertion expression.
 */
function readExportedStringArray(rootNode, name) {
  let found = null;
  walk(rootNode, (node) => {
    if (node.type !== 'export_statement') return true;
    walk(node, (inner) => {
      if (inner.type !== 'variable_declarator') return true;
      const nameNode = inner.childForFieldName('name');
      if (!nameNode || nameNode.text !== name) return true;
      let valueNode = inner.childForFieldName('value');
      // Unwrap `[...] as const` / `[...] satisfies T` (TS assertion wrappers around the array).
      if (valueNode && (valueNode.type === 'as_expression' || valueNode.type === 'satisfies_expression')) {
        valueNode = valueNode.namedChildren[0];
      }
      if (!valueNode || valueNode.type !== 'array') return true;
      const values = [];
      for (const child of valueNode.namedChildren) {
        const v = stringValue(child);
        if (typeof v === 'string') values.push(v);
      }
      found = values;
      return false;
    });
    return true;
  });
  return found;
}

function isSpec(filePath) {
  return /\.spec\.ts$/.test(filePath);
}

function isSurfacesModule(filePath) {
  return /\/support\/surfaces\.ts$/.test(filePath) || /(^|\/)surfaces\.ts$/.test(filePath);
}

export function check(ctx) {
  const violations = [];

  // 1. The authoritative manifest from support/surfaces.ts.
  let manifest = null;
  let manifestFile = null;
  for (const file of ctx.files) {
    if (!file.ast || !isSurfacesModule(file.path)) continue;
    const arr = readExportedStringArray(file.ast.rootNode, 'SURFACE_MANIFEST');
    if (arr) {
      manifest = arr;
      manifestFile = file.path;
      break;
    }
  }

  if (!manifest) {
    // Fail closed — a missing/empty manifest must never read as "everything covered".
    const first = ctx.files[0];
    violations.push({
      file: first ? first.path : undefined,
      line: 1,
      column: 0,
      message:
        `The §3a surface manifest (export const SURFACE_MANIFEST in support/surfaces.ts) could not be read ` +
        `from this suite's files. Every navigable surface's e2e coverage is keyed to it; without it nothing ` +
        `can be verified covered. Restore support/surfaces.ts with the SURFACE_MANIFEST string array.`,
    });
    return violations;
  }
  const manifestSet = new Set(manifest);

  // 2. Union every spec's exported COVERS.
  const covered = new Set();
  const coverers = new Map(); // surfaceId -> [spec paths] (for the error message)
  for (const file of ctx.files) {
    if (!file.ast || !isSpec(file.path)) continue;
    const covers = readExportedStringArray(file.ast.rootNode, 'COVERS');
    if (!covers) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message:
          `Portal e2e spec '${file.path}' does not export a COVERS string array. Every spec must declare ` +
          `which §3a surfaces it covers (export const COVERS = [...]) so coverage is mechanically verifiable ` +
          `against the surface manifest — even an empty COVERS = [] (a spec that only hardens existing surfaces).`,
      });
      continue;
    }
    for (const id of covers) {
      if (!manifestSet.has(id)) {
        violations.push({
          file: file.path,
          line: 1,
          column: 0,
          message:
            `Portal e2e spec '${file.path}' lists surface '${id}' in COVERS, but '${id}' is not in the §3a ` +
            `surface manifest (${manifestFile}). A stale or mistyped id covers nothing real. Fix the id, or ` +
            `add '${id}' to SURFACE_MANIFEST if it is a genuine new surface.`,
        });
        continue;
      }
      covered.add(id);
      const list = coverers.get(id) ?? [];
      list.push(file.path);
      coverers.set(id, list);
    }
  }

  // 3. Every manifest surface must be covered by at least one spec.
  for (const surface of manifest) {
    if (!covered.has(surface)) {
      violations.push({
        file: manifestFile,
        line: 1,
        column: 0,
        message:
          `§3a surface '${surface}' has NO Playwright + Chromium e2e spec covering it. Every navigable surface ` +
          `must be driven by at least one real-browser spec that declares it in COVERS. Add a spec (or extend ` +
          `an existing one) that opens this surface and asserts it renders / its transitions land, and list ` +
          `'${surface}' in that spec's exported COVERS array.`,
      });
    }
  }

  return violations;
}
