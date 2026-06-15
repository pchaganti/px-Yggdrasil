// reference/layout — GENERIC reference-catalogue aspect (Layer 1).
//
// The catalogue directory conforms to the kind's `layout`:
//   - every `.md` path (relative to the kind root) matches `pattern`;
//   - each `<segment>` value is within its `segments.<segment>` enum;
//   - no disallowed files exist — every file basename matches one of `allow_only`.
// Catches stray files, mis-placed docs, and typo'd segment dirs. Parameterised by
// the schema; knows nothing about relations.
//
// Scope: this check validates the node's own mapped `.md` files against the pattern,
// and lists each language directory those files live in to catch disallowed siblings.
// (A node owns one kind sub-area; the kind root holds the descriptor + the sub-dirs.)

export function check(ctx) {
  const violations = [];

  const mdFiles = ctx.node.files.filter((f) => f.path.endsWith('.md'));
  if (mdFiles.length === 0) return violations;

  // The kind root = the directory holding _reference-schema.yaml. The descriptor is
  // mapped by this node or an ancestor (the kind-root node); we find it through the
  // graph so we only read a mapped path (inside the allowed-reads set).
  const schemaPath = findSchemaPath(ctx);
  if (!schemaPath) {
    violations.push({
      file: mdFiles[0].path,
      message:
        'No _reference-schema.yaml mapped on this node or any ancestor; cannot determine the kind root or its layout.',
      line: 1,
      column: 1,
    });
    return violations;
  }
  const root = schemaPath.includes('/') ? schemaPath.slice(0, schemaPath.lastIndexOf('/')) : '';
  // parseYaml(path) reads + parses through the allowed-reads set (own/ancestor mapping).
  const schema = ctx.parseYaml(schemaPath);
  const layout = schema?.layout ?? {};
  const pattern = layout.pattern ?? '';
  const segDefs = layout.segments ?? {};
  const allowOnly = layout.allow_only ?? ['*.md', '_reference-schema.yaml'];

  const patternSegs = pattern.split('/').filter((s) => s.length > 0);

  // 1. Each .md path matches the pattern + segment enums.
  const dirs = new Set();
  for (const file of mdFiles) {
    const rel = relativeTo(root, file.path);
    if (rel === undefined) {
      violations.push({
        file: file.path,
        message: `Document lives outside the kind root '${root}'.`,
        line: 1,
        column: 1,
      });
      continue;
    }
    const relSegs = rel.split('/');
    if (relSegs.length !== patternSegs.length) {
      violations.push({
        file: file.path,
        message: `Path '${rel}' (under ${root}/) does not match layout pattern '${pattern}': expected ${patternSegs.length} segments, got ${relSegs.length}.`,
        line: 1,
        column: 1,
      });
      continue;
    }
    for (let i = 0; i < patternSegs.length; i++) {
      const tok = patternSegs[i];
      const value = relSegs[i];
      const m = /^<(.+)>(\.md)?$/.exec(tok);
      if (!m) {
        // literal segment in the pattern
        if (value !== tok) {
          violations.push({
            file: file.path,
            message: `Path segment '${value}' must be the literal '${tok}' per layout pattern '${pattern}'.`,
            line: 1,
            column: 1,
          });
        }
        continue;
      }
      const segName = m[1];
      const segValue = m[2] ? value.replace(/\.md$/, '') : value;
      const allowed = segDefs[segName];
      if (Array.isArray(allowed) && !allowed.includes(segValue)) {
        violations.push({
          file: file.path,
          message: `Path segment '${segValue}' for <${segName}> is not in the allowed set [${allowed.join(', ')}].`,
          line: 1,
          column: 1,
        });
      }
    }
    if (file.path.includes('/')) dirs.add(file.path.slice(0, file.path.lastIndexOf('/')));
  }

  // 2. No disallowed files in each language directory the node's docs occupy. The
  //    violation is anchored on a MAPPED doc (the stray file is not in ctx, so it
  //    cannot be the violation's `file`); the stray path is named in the message.
  const anchor = mdFiles[0].path;
  for (const dir of dirs) {
    for (const entry of ctx.fs.list(dir)) {
      if (entry.kind !== 'file') continue;
      if (!allowOnly.some((glob) => basenameMatches(glob, entry.name))) {
        violations.push({
          file: anchor,
          message: `Disallowed file '${dir}/${entry.name}'; only [${allowOnly.join(', ')}] are permitted under the catalogue.`,
          line: 1,
          column: 1,
        });
      }
    }
  }

  return violations;
}

function findSchemaPath(ctx) {
  const nodesToCheck = [ctx.node];
  let id = ctx.node.id;
  while (id.includes('/')) {
    id = id.slice(0, id.lastIndexOf('/'));
    let anc;
    try {
      anc = ctx.graph.node(id);
    } catch {
      break;
    }
    if (anc) nodesToCheck.push(anc);
  }
  for (const node of nodesToCheck) {
    for (const f of node.files) {
      if (f.path.endsWith('/_reference-schema.yaml') || f.path === '_reference-schema.yaml') {
        return f.path;
      }
    }
  }
  return undefined;
}

function relativeTo(root, filePath) {
  const prefix = `${root}/`;
  if (!filePath.startsWith(prefix)) return undefined;
  return filePath.slice(prefix.length);
}

// Minimal basename glob: supports a single leading `*` (e.g. `*.md`) and exact names.
function basenameMatches(glob, name) {
  if (glob.startsWith('*')) return name.endsWith(glob.slice(1));
  return name === glob;
}
