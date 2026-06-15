// reference/doc-shape — GENERIC reference-catalogue aspect (Layer 1).
//
// Each `.md` in a reference-catalogue node is validated against the NEAREST
// `_reference-schema.yaml` (the governing kind descriptor):
//   - frontmatter block present;
//   - every `frontmatter.required` field present;
//   - every `frontmatter.enums` field within its allowed values;
//   - `id` equals the filename stem;
//   - `language` (when a `<language>` layout segment exists) equals the path segment;
//   - every `sections.required` `##` heading present, in the declared order.
// One violation per problem. Knows nothing about relations — fully parameterised
// by the schema, so any future kind reuses it unchanged.

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.path.endsWith('.md')) continue; // descriptor + non-doc files skipped

    const schema = loadNearestSchema(ctx, file.path);
    if (!schema) {
      violations.push({
        file: file.path,
        message:
          'No _reference-schema.yaml found in any ancestor directory. Every reference-catalogue kind must declare its structure in reference/<kind>/_reference-schema.yaml.',
        line: 1,
        column: 1,
      });
      continue;
    }

    const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(file.content);
    if (!fmMatch) {
      violations.push({
        file: file.path,
        message: 'Missing YAML frontmatter block (--- … ---) at the top of the document.',
        line: 1,
        column: 1,
      });
      continue;
    }
    const fm = parseFrontmatter(fmMatch[1]);

    // Required frontmatter fields.
    const required = schema?.frontmatter?.required ?? [];
    for (const field of required) {
      if (fm[field] === undefined || fm[field] === '') {
        violations.push({
          file: file.path,
          message: `Frontmatter is missing required field '${field}'.`,
          line: 1,
          column: 1,
        });
      }
    }

    // Enum fields.
    const enums = schema?.frontmatter?.enums ?? {};
    for (const [field, allowed] of Object.entries(enums)) {
      const value = fm[field];
      if (value === undefined || value === '') continue; // missing already reported above
      if (Array.isArray(allowed) && !allowed.includes(value)) {
        violations.push({
          file: file.path,
          message: `Frontmatter field '${field}' has value '${value}', not in allowed set [${allowed.join(', ')}].`,
          line: 1,
          column: 1,
        });
      }
    }

    // id == filename stem.
    const stem = file.path.split('/').pop().replace(/\.md$/, '');
    if (fm.id !== undefined && fm.id !== stem) {
      violations.push({
        file: file.path,
        message: `Frontmatter id '${fm.id}' must equal the filename stem '${stem}'.`,
        line: 1,
        column: 1,
      });
    }

    // language == <language> path segment (when the layout declares that segment).
    const segments = schema?.layout?.segments ?? {};
    if (Object.prototype.hasOwnProperty.call(segments, 'language') && fm.language !== undefined) {
      const seg = languageSegment(file.path);
      if (seg !== undefined && fm.language !== seg) {
        violations.push({
          file: file.path,
          message: `Frontmatter language '${fm.language}' must equal the path segment '${seg}'.`,
          line: 1,
          column: 1,
        });
      }
    }

    // Required sections present and in declared order.
    const sections = schema?.sections?.required ?? [];
    const headings = [];
    for (const m of file.content.matchAll(/^##\s+(.+?)\s*$/gm)) headings.push(m[1].trim());
    let cursor = 0;
    for (const wanted of sections) {
      const at = headings.indexOf(wanted, cursor);
      if (at === -1) {
        const laterAt = headings.indexOf(wanted);
        if (laterAt === -1) {
          violations.push({
            file: file.path,
            message: `Missing required section '## ${wanted}'.`,
            line: 1,
            column: 1,
          });
        } else {
          violations.push({
            file: file.path,
            message: `Required section '## ${wanted}' is out of order; expected order: ${sections.map((s) => `## ${s}`).join(', ')}.`,
            line: 1,
            column: 1,
          });
        }
      } else {
        cursor = at + 1;
      }
    }
  }

  return violations;
}

// Locate the governing _reference-schema.yaml via the graph: it is mapped by this
// node or one of its ancestors (the kind-root node). We read it only through a
// mapped path (own/ancestor mapping → inside the allowed-reads set), never by
// probing arbitrary directories.
function loadNearestSchema(ctx, filePath) {
  const schemaPath = findSchemaPath(ctx);
  if (!schemaPath) return undefined;
  // parseYaml(path) reads + parses through the allowed-reads set; passing raw content
  // would be (mis)interpreted as a path. The schema is an own/ancestor mapping → allowed.
  return ctx.parseYaml(schemaPath);
}

function findSchemaPath(ctx) {
  // Own node first, then each ancestor node, nearest outward.
  const nodesToCheck = [ctx.node];
  let id = ctx.node.id;
  while (id.includes('/')) {
    id = id.slice(0, id.lastIndexOf('/'));
    let anc;
    try {
      anc = ctx.graph.node(id);
    } catch {
      break; // outside the allowed graph-read set — stop walking
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

// The `<language>` segment of a `reference/relations/<language>/<id>.md` path:
// the directory segment immediately under the kind root (the file's parent dir name).
function languageSegment(filePath) {
  const segs = filePath.split('/');
  return segs.length >= 2 ? segs[segs.length - 2] : undefined;
}

// Minimal `key: value` frontmatter parser (quotes stripped). Matches the runner's.
function parseFrontmatter(block) {
  const out = {};
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
