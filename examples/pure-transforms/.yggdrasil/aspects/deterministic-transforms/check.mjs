// Deterministic aspect: functions in the transforms package must be reproducible.
//
// A reproducible transform is a pure mapping from inputs to outputs — replaying
// the pipeline over the same source data must yield the same result. Two things
// break that guarantee: reading the wall clock (the result now depends on WHEN
// it ran) and drawing randomness (the result depends on a seed). This check is a
// robust line scan over the transforms package's Python source and refuses any
// line that reads the clock or draws randomness.
//
// This runs at zero LLM cost and demonstrates that Yggdrasil's deterministic
// layer works on a non-TypeScript language (here, Python) — the same check(ctx)
// contract, driven by a plain text scan of file.content.

// Only files inside the transforms package are subject to the rule. The pipeline
// orchestrator (src/pipeline.py) is deliberately allowed to time a run and log.
const TRANSFORMS_RE = /(^|\/)transforms\/[^/]+\.py$/;

// Each forbidden pattern: a matcher against a line, plus the human-facing reason.
// The matchers are written against source with inline comments already stripped,
// so a token appearing only inside a comment never trips the rule.
const FORBIDDEN = [
  {
    re: /\bdatetime\s*\.\s*now\s*\(/,
    label: "datetime.now()",
  },
  {
    re: /\bdatetime\s*\.\s*utcnow\s*\(/,
    label: "datetime.utcnow()",
  },
  {
    re: /\btime\s*\.\s*time\s*\(/,
    label: "time.time()",
  },
  {
    // random.<anything>( — random.random(), random.randint(), random.choice(), ...
    re: /\brandom\s*\.\s*[A-Za-z_]\w*\s*\(/,
    label: "random.* (non-deterministic randomness)",
  },
];

// Strip a trailing Python inline comment (a '#' that is not inside a string
// literal) so a forbidden token mentioned in a comment is not a false positive.
function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\") {
      i += 1; // skip the escaped character
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!TRANSFORMS_RE.test(file.path)) continue; // only the transforms package
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const code = stripInlineComment(lines[index]);
      for (const rule of FORBIDDEN) {
        const match = rule.re.exec(code);
        if (match) {
          violations.push({
            file: file.path,
            line: index + 1,
            column: match.index,
            message:
              `Transforms must be reproducible: line references ${rule.label}. ` +
              `Reading the wall clock or drawing randomness makes the pipeline ` +
              `unreplayable. Pass any needed timestamp or seed in as an argument, ` +
              `or move this concern to the orchestrator (pipeline.py).`,
          });
        }
      }
    }
  }
  return violations;
}
