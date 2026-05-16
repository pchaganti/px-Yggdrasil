import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_RULES_CONTENT } from './rules.js';

const AGENT_RULES_IMPORT = '@.yggdrasil/agent-rules.md';
const YGGDRASIL_START = '<!-- yggdrasil:start -->';
const YGGDRASIL_END = '<!-- yggdrasil:end -->';
const YGGDRASIL_SECTION = `## Yggdrasil\n\n${AGENT_RULES_CONTENT}`;
const YGGDRASIL_BLOCK = `${YGGDRASIL_START}\n${YGGDRASIL_SECTION}\n${YGGDRASIL_END}`;

export type Platform =
  | 'cursor'
  | 'claude-code'
  | 'copilot'
  | 'cline'
  | 'roocode'
  | 'codex'
  | 'windsurf'
  | 'aider'
  | 'gemini'
  | 'amp'
  | 'opencode'
  | 'codebuddy'
  | 'generic';

export const PLATFORMS: Platform[] = [
  'cursor',
  'claude-code',
  'copilot',
  'cline',
  'roocode',
  'codex',
  'windsurf',
  'aider',
  'gemini',
  'amp',
  'opencode',
  'codebuddy',
  'generic',
];

export async function installRulesForPlatform(
  projectRoot: string,
  platform: Platform,
): Promise<string> {
  const agentRulesPath = path.join(projectRoot, '.yggdrasil', 'agent-rules.md');

  let result: string;
  switch (platform) {
    case 'cursor':
      result = await installForCursor(projectRoot); break;
    case 'claude-code':
      result = await installForClaudeCode(projectRoot, agentRulesPath); break;
    case 'copilot':
      result = await installForCopilot(projectRoot); break;
    case 'cline':
      result = await installForCline(projectRoot); break;
    case 'roocode':
      result = await installForRooCode(projectRoot); break;
    case 'codex':
      result = await installForCodex(projectRoot); break;
    case 'windsurf':
      result = await installForWindsurf(projectRoot); break;
    case 'aider':
      result = await installForAider(projectRoot, agentRulesPath); break;
    case 'gemini':
      result = await installForGemini(projectRoot, agentRulesPath); break;
    case 'amp':
      result = await installForAmp(projectRoot, agentRulesPath); break;
    case 'opencode':
      result = await installForOpenCode(projectRoot); break;
    case 'codebuddy':
      result = await installForCodeBuddy(projectRoot); break;
    case 'generic':
    default:
      result = await installForGeneric(projectRoot); break;
  }
  return result.replace(/\\/g, '/').replace(/\/+$/, '');
}

async function ensureAgentRules(agentRulesPath: string): Promise<void> {
  await mkdir(path.dirname(agentRulesPath), { recursive: true });
  await writeFile(agentRulesPath, AGENT_RULES_CONTENT, 'utf-8');
}

async function installForCursor(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, '.cursor', 'rules');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'yggdrasil.mdc');
  const content = `---
description: Yggdrasil — continuous architecture enforcement
alwaysApply: true
---

${AGENT_RULES_CONTENT}`;
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function installForClaudeCode(projectRoot: string, agentRulesPath: string): Promise<string> {
  await ensureAgentRules(agentRulesPath);
  const filePath = path.join(projectRoot, 'CLAUDE.md');
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch {
    /* file doesn't exist */
  }
  const importLine = AGENT_RULES_IMPORT;
  if (existing.includes(importLine)) {
    return agentRulesPath;
  }
  const content = existing.trimEnd() ? `${existing.trimEnd()}\n${importLine}\n` : `${importLine}\n`;
  await writeFile(filePath, content, 'utf-8');
  return agentRulesPath;
}

async function installForCopilot(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, '.github');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'copilot-instructions.md');
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch {
    /* file doesn't exist */
  }
  let content: string;
  if (existing.includes(YGGDRASIL_START) && existing.includes(YGGDRASIL_END)) {
    content = existing.replace(
      new RegExp(`${escapeRegex(YGGDRASIL_START)}[\\s\\S]*?${escapeRegex(YGGDRASIL_END)}`, 'g'),
      () => YGGDRASIL_BLOCK,
    );
  } else {
    content = existing.trimEnd()
      ? `${existing.trimEnd()}\n\n${YGGDRASIL_BLOCK}\n`
      : `${YGGDRASIL_BLOCK}\n`;
  }
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function installForCline(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, '.clinerules');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'yggdrasil.md');
  await writeFile(filePath, AGENT_RULES_CONTENT, 'utf-8');
  return filePath;
}

async function installForRooCode(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, '.roo', 'rules');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'yggdrasil.md');
  await writeFile(filePath, AGENT_RULES_CONTENT, 'utf-8');
  return filePath;
}

async function installForCodex(projectRoot: string): Promise<string> {
  const filePath = path.join(projectRoot, 'AGENTS.md');
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch {
    /* file doesn't exist */
  }
  let content: string;
  if (existing.includes(YGGDRASIL_START) && existing.includes(YGGDRASIL_END)) {
    content = existing.replace(
      new RegExp(`${escapeRegex(YGGDRASIL_START)}[\\s\\S]*?${escapeRegex(YGGDRASIL_END)}`, 'g'),
      () => YGGDRASIL_BLOCK,
    );
  } else {
    content = existing.trimEnd()
      ? `${existing.trimEnd()}\n\n${YGGDRASIL_BLOCK}\n`
      : `${YGGDRASIL_BLOCK}\n`;
  }
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function installForWindsurf(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, '.windsurf', 'rules');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'yggdrasil.md');
  await writeFile(filePath, AGENT_RULES_CONTENT, 'utf-8');
  return filePath;
}

async function installForAider(projectRoot: string, agentRulesPath: string): Promise<string> {
  await ensureAgentRules(agentRulesPath);
  const filePath = path.join(projectRoot, '.aider.conf.yml');
  const entry = '.yggdrasil/agent-rules.md';
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch {
    /* file doesn't exist */
  }
  if (existing.includes(entry)) {
    return agentRulesPath;
  }
  const content = appendAiderReadEntry(existing, entry);
  await writeFile(filePath, content, 'utf-8');
  return agentRulesPath;
}

function appendAiderReadEntry(existing: string, entry: string): string {
  const newItem = `  - ${entry}  # added by yg init\n`;
  const readBlock = /^read:\s*\n((?:\s+-\s+[^\n]+\n)*)/m;
  const match = existing.match(readBlock);
  if (match) {
    return existing.replace(match[0], `read:\n${match[1]}${newItem}`);
  }
  const readEmpty = /^read:\s*$/m;
  if (readEmpty.test(existing)) {
    return existing.replace(readEmpty, `read:\n${newItem}`);
  }
  const trimmed = existing.trimEnd();
  return trimmed ? `${trimmed}\n\nread:\n${newItem}` : `read:\n${newItem}`;
}

async function installForGemini(projectRoot: string, agentRulesPath: string): Promise<string> {
  await ensureAgentRules(agentRulesPath);
  const filePath = path.join(projectRoot, 'GEMINI.md');
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch {
    /* file doesn't exist */
  }
  const importLine = AGENT_RULES_IMPORT;
  if (existing.includes(importLine)) {
    return agentRulesPath;
  }
  const content = existing.trimEnd() ? `${existing.trimEnd()}\n${importLine}\n` : `${importLine}\n`;
  await writeFile(filePath, content, 'utf-8');
  return agentRulesPath;
}

async function installForAmp(projectRoot: string, agentRulesPath: string): Promise<string> {
  await ensureAgentRules(agentRulesPath);
  const filePath = path.join(projectRoot, 'AGENTS.md');
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch {
    /* file doesn't exist */
  }
  const importLine = AGENT_RULES_IMPORT;
  if (existing.includes(importLine)) {
    return agentRulesPath;
  }
  const content = existing.trimEnd() ? `${existing.trimEnd()}\n${importLine}\n` : `${importLine}\n`;
  await writeFile(filePath, content, 'utf-8');
  return agentRulesPath;
}

async function installForOpenCode(projectRoot: string): Promise<string> {
  return installForCodex(projectRoot);
}

async function installForCodeBuddy(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, '.codebuddy', 'rules', 'yggdrasil');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'RULE.mdc');
  const content = `---
description: Yggdrasil — continuous verification for AI-generated code
alwaysApply: true
---

${AGENT_RULES_CONTENT}`;
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function installForGeneric(projectRoot: string): Promise<string> {
  const filePath = path.join(projectRoot, '.yggdrasil', 'agent-rules.md');
  await ensureAgentRules(filePath);
  return filePath;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
