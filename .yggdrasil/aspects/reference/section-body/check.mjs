// reference/section-body — GENERIC reference-catalogue aspect (Layer 1).
//
// Validates the BODY of each `.md` section against its kind's
// `_reference-schema.yaml` `sections.body` contract — the layer doc-shape leaves
// open (doc-shape only checks that the `##` headings exist, never their content).
//
// Body-shape vocabulary (kind declares which sections use which shape):
//   fence       — { backticks: N }
//                 the section body must hold EXACTLY ONE balanced N-backtick
//                 fence (so a reply that itself contains a ```json block embeds
//                 cleanly inside a ````-fence). 0 → missing; odd → unbalanced.
//   keyed-list  — { keys: [...], enums: { key: [...] }, require_by: { <fmValue>: [keys] } }
//                 lines of `- key: value`. Every key must be in `keys` (a typo'd
//                 key is the dangerous case — it silently makes a runner assertion
//                 vanish, so the doc passes asserting nothing). Each value must be
//                 in `enums[key]` when an enum is declared. `require_by` keys the
//                 required-key set off a frontmatter field value (here: the
//                 `expectation` field), catching frontmatter↔body inconsistency.
//
// No-op for any kind whose schema declares no `sections.body` (e.g. relations) —
// fully parameterised by the schema, like doc-shape and layout.

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.path.endsWith('.md')) continue;

    const schema = loadNearestSchema(ctx, file.path);
    const body = schema?.sections?.body;
    if (!body || typeof body !== 'object') continue; // kind declares no body contract → no-op

    const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(file.content);
    const fm = fmMatch ? parseFrontmatter(fmMatch[1]) : {};

    for (const [section, contract] of Object.entries(body)) {
      const sectionBody = extractSection(file.content, section);
      if (sectionBody === undefined) continue; // missing heading → doc-shape reports it

      const problems =
        contract.shape === 'fence'
          ? checkFence(sectionBody, contract)
          : contract.shape === 'keyed-list'
            ? checkKeyedList(sectionBody, contract, fm)
            : [`Unknown section body shape '${contract.shape}' for '## ${section}' in _reference-schema.yaml.`];

      for (const message of problems) {
        violations.push({ file: file.path, message: `## ${section}: ${message}`, line: 1, column: 1 });
      }
    }
  }

  return violations;
}

// ── Shapes ────────────────────────────────────────────────────────────────────

function checkFence(body, contract) {
  const n = contract.backticks ?? 3;
  // Lines that are EXACTLY n backticks (not n+1), at line start — fence open/close.
  const re = new RegExp('^' + '`'.repeat(n) + '(?!`)', 'gm');
  const markers = (body.match(re) || []).length;
  if (markers === 0) return [`must contain one ${n}-backtick fence (found none).`];
  if (markers % 2 !== 0) return [`has an unbalanced ${n}-backtick fence (${markers} markers).`];
  if (markers !== 2) return [`must contain exactly one ${n}-backtick fence (found ${markers / 2}).`];
  return [];
}

function checkKeyedList(body, contract, fm) {
  const problems = [];
  const keys = contract.keys ?? [];
  const enums = contract.enums ?? {};
  const seen = new Set();

  for (const raw of body.split('\n')) {
    const m = /^-\s*([a-zA-Z0-9_]+)\s*:\s*(.+?)\s*$/.exec(raw.trim());
    if (!m) continue; // blank / prose line
    const key = m[1];
    const value = m[2];
    if (!keys.includes(key)) {
      problems.push(`unknown key '${key}' (allowed: ${keys.join(', ')}).`);
      continue;
    }
    seen.add(key);
    if (Array.isArray(enums[key]) && !enums[key].map(String).includes(value)) {
      problems.push(`key '${key}' has value '${value}', not in [${enums[key].map(String).join(', ')}].`);
    }
  }

  // require_by: a frontmatter `expectation` value maps to the keys that must appear.
  const requireBy = contract.require_by ?? {};
  const required = requireBy[fm.expectation] ?? [];
  for (const k of required) {
    if (!seen.has(k)) {
      problems.push(`expectation '${fm.expectation}' requires key '${k}', which is missing (an empty/typo'd Expect makes the case assert nothing).`);
    }
  }
  return problems;
}

// ── Section + schema helpers (mirror doc-shape) ─────────────────────────────────

function extractSection(content, name) {
  const re = new RegExp('^##\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm');
  const m = re.exec(content);
  if (!m) return undefined;
  const rest = content.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function loadNearestSchema(ctx, filePath) {
  const schemaPath = findSchemaPath(ctx);
  if (!schemaPath) return undefined;
  return ctx.parseYaml(schemaPath);
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

function parseFrontmatter(block) {
  const out = {};
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
