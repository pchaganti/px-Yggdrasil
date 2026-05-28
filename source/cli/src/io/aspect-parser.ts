import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { AspectDef, AspectReviewerSpec } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import type { WhenPredicate } from '../model/when.js';
import { readArtifacts } from './artifact-reader.js';
import { parseWhen, parseAspectAttachment } from '../core/parsing/when-parser.js';

export type ParseAspectResult =
  | { ok: true; aspect: AspectDef }
  | { ok: false; aspectId: string; errors: Array<{ code: string; messageData: IssueMessage }> };

export async function parseAspect(
  aspectDir: string,
  aspectYamlPath: string,
  id: string,
): Promise<ParseAspectResult> {
  const idTrimmed = id?.trim() ?? '';
  if (!idTrimmed) {
    return {
      ok: false,
      aspectId: id ?? '',
      errors: [{
        code: 'aspect-invalid-id',
        messageData: {
          what: `yg-aspect.yaml at ${aspectYamlPath}: aspect id is empty`,
          why: 'aspect id must be the relative path under aspects/',
          next: 'rename the parent directory to match the intended aspect id',
        },
      }],
    };
  }

  const content = await readFile(aspectYamlPath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      aspectId: idTrimmed,
      errors: [{
        code: 'yaml-invalid',
        messageData: {
          what: `yg-aspect.yaml at ${aspectYamlPath}: file is empty or not a YAML mapping`,
          why: 'aspect definitions must be a YAML mapping',
          next: 'add a valid YAML mapping (name, description, reviewer, etc.)',
        },
      }],
    };
  }

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    return {
      ok: false,
      aspectId: idTrimmed,
      errors: [{
        code: 'aspect-name-missing',
        messageData: {
          what: `yg-aspect.yaml at ${aspectYamlPath}: missing or empty 'name'`,
          why: 'every aspect must declare a name',
          next: 'add `name: <YourAspectName>` to the file',
        },
      }],
    };
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : undefined;

  const reviewerResult = parseReviewer(raw.reviewer, idTrimmed);
  if (!reviewerResult.ok) {
    return { ok: false, aspectId: idTrimmed, errors: reviewerResult.errors };
  }
  const reviewer: AspectReviewerSpec = reviewerResult.value;

  const artifacts = await readArtifacts(aspectDir, ['yg-aspect.yaml']);

  let implies: string[] | undefined;
  let impliesWhens: Record<string, WhenPredicate> | undefined;
  if (raw.implies !== undefined) {
    if (!Array.isArray(raw.implies)) {
      return {
        ok: false,
        aspectId: idTrimmed,
        errors: [{
          code: 'aspect-implies-not-array',
          messageData: {
            what: `yg-aspect.yaml at ${aspectYamlPath}: 'implies' must be an array`,
            why: 'implies declares dependent aspects as a list',
            next: 'replace value with [aspect-id-1, aspect-id-2, ...]',
          },
        }],
      };
    }
    implies = [];
    for (let i = 0; i < raw.implies.length; i++) {
      const parsed = parseAspectAttachment(
        raw.implies[i],
        `yg-aspect.yaml at ${aspectYamlPath}: implies[${i}]`,
      );
      implies.push(parsed.id);
      if (parsed.when) {
        (impliesWhens ??= {})[parsed.id] = parsed.when;
      }
    }
  }

  let when: WhenPredicate | undefined;
  if (raw.when !== undefined) {
    when = parseWhen(raw.when, `yg-aspect.yaml at ${aspectYamlPath}: when`);
  }

  return {
    ok: true,
    aspect: {
      name: (raw.name as string).trim(),
      id: idTrimmed,
      description,
      reviewer,
      ...(raw.language !== undefined && { language: raw.language as string[] }),
      implies,
      ...(impliesWhens && { impliesWhens }),
      ...(when && { when }),
      artifacts,
    },
  };
}

function parseReviewer(
  raw: unknown,
  aspectId: string,
):
  | { ok: true; value: AspectReviewerSpec }
  | { ok: false; errors: Array<{ code: string; messageData: IssueMessage }> }
{
  // Step 1: structural/legacy — return on first (these mean file is fundamentally wrong)
  if (raw === undefined || raw === null) {
    return {
      ok: false,
      errors: [{
        code: 'aspect-reviewer-missing',
        messageData: {
          what: `aspect '${aspectId}' has no reviewer: block (field absent or null)`,
          why: 'every aspect must declare its reviewer explicitly (no implicit default)',
          next: 'add `reviewer:\\n  type: llm` or `reviewer:\\n  type: ast`',
        },
      }],
    };
  }
  if (typeof raw === 'string') {
    return {
      ok: false,
      errors: [{
        code: 'aspect-reviewer-legacy-string',
        messageData: {
          what: `aspect '${aspectId}' has reviewer: as a string ('${raw}')`,
          why: 'reviewer: must be a mapping with a type: key',
          next: 'run `yg init --upgrade` to migrate, or manually replace with `reviewer:\\n  type: <X>`',
        },
      }],
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{
        code: 'aspect-reviewer-not-mapping',
        messageData: {
          what: `aspect '${aspectId}' has reviewer: value that is not a YAML mapping`,
          why: 'reviewer: accepts an object with type: and optional tier:',
          next: 'replace with `reviewer:\\n  type: llm`',
        },
      }],
    };
  }

  // Step 2+3: collect independent errors on the mapping
  const errors: Array<{ code: string; messageData: IssueMessage }> = [];
  const obj = raw as Record<string, unknown>;

  // Step 2: structural — type missing or invalid
  let typeValid = false;
  if (!('type' in obj)) {
    errors.push({
      code: 'aspect-reviewer-type-missing',
      messageData: {
        what: `aspect '${aspectId}' has reviewer: mapping without type:`,
        why: 'type: distinguishes LLM and AST aspects',
        next: 'add `type: llm` or `type: ast` under reviewer:',
      },
    });
  } else if (obj.type !== 'llm' && obj.type !== 'ast') {
    errors.push({
      code: 'aspect-reviewer-type-invalid',
      messageData: {
        what: `aspect '${aspectId}' has invalid reviewer.type: '${String(obj.type)}'`,
        why: 'only "llm" and "ast" are valid',
        next: 'change to type: llm or type: ast',
      },
    });
  } else {
    typeValid = true;
  }

  // Step 3: unknown keys — INDEPENDENT of type presence/validity
  const allowedKeys = new Set(['type', 'tier']);
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.has(k)) {
      errors.push({
        code: 'aspect-reviewer-unknown-key',
        messageData: {
          what: `aspect '${aspectId}' has unknown reviewer key '${k}'`,
          why: 'reviewer: accepts only `type` and `tier`',
          next: 'remove the unknown key (provider/model lives in the config tier, not the aspect)',
        },
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Step 4: cross-field — only when type is valid
  if (!typeValid) return { ok: false, errors }; // unreachable but type-safe

  const type = obj.type as 'llm' | 'ast';
  if (obj.tier !== undefined) {
    if (typeof obj.tier !== 'string' || obj.tier.trim() === '') {
      return {
        ok: false,
        errors: [{
          code: 'aspect-reviewer-tier-invalid',
          messageData: {
            what: `aspect '${aspectId}' has empty or non-string reviewer.tier`,
            why: 'tier must be a non-empty string matching a tier name in yg-config.yaml',
            next: 'set tier: <name> or remove the field to use the default',
          },
        }],
      };
    }
    if (type === 'ast') {
      return {
        ok: false,
        errors: [{
          code: 'aspect-ast-tier-not-allowed',
          messageData: {
            what: `aspect '${aspectId}' has reviewer.type: ast together with reviewer.tier: '${obj.tier}'`,
            why: 'AST aspects run locally without an LLM; tiers do not apply',
            next: 'remove tier: from the aspect',
          },
        }],
      };
    }
    return { ok: true, value: { type, tier: obj.tier as string } };
  }
  return { ok: true, value: { type } };
}
