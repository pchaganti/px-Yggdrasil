import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerInitCommand, freshInitNonInteractive } from '../../../src/cli/init.js';

describe('init command', () => {
  it('registers init command', () => {
    const program = new Command();
    registerInitCommand(program);
    expect(program.commands.map(c => c.name())).toContain('init');
  });

  it('init command exposes --upgrade option', () => {
    const program = new Command();
    registerInitCommand(program);
    const cmd = program.commands.find(c => c.name() === 'init')!;
    const options = cmd.options.map(o => o.long);
    expect(options).toContain('--upgrade');
  });

  it('init command exposes the non-interactive fresh-init options', () => {
    const program = new Command();
    registerInitCommand(program);
    const cmd = program.commands.find(c => c.name() === 'init')!;
    const options = cmd.options.map(o => o.long);
    expect(options).toEqual(expect.arrayContaining(['--provider', '--model', '--endpoint']));
  });
});

describe('freshInitNonInteractive', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function freshDir(label: string): Promise<{ root: string; ygg: string }> {
    const root = await mkdtemp(path.join(tmpdir(), `yg-noninteractive-${label}-`));
    dirs.push(root);
    return { root, ygg: path.join(root, '.yggdrasil') };
  }

  it('writes a require-nothing coverage baseline and the named reviewer tier (claude-code needs no key)', async () => {
    const { root, ygg } = await freshDir('happy');
    await freshInitNonInteractive(root, ygg, { platform: 'claude-code', provider: 'claude-code', model: 'haiku' });
    const cfg = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    // The fresh config opts into require-nothing coverage (green from the first check).
    expect(cfg).toContain('coverage:');
    expect(cfg).toMatch(/required:\s*\[\]/);
    // The named CLI-agent reviewer tier is recorded with the model given verbatim.
    expect(cfg).toContain('provider: claude-code');
    expect(cfg).toContain('model: haiku');
  });

  it('defaults the Ollama endpoint when --endpoint is omitted', async () => {
    const { root, ygg } = await freshDir('ollama');
    await freshInitNonInteractive(root, ygg, { platform: 'generic', provider: 'ollama', model: 'qwen3' });
    const cfg = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toContain('endpoint: http://localhost:11434');
  });

  it('exits 1 when --model is missing (no default model is applied)', async () => {
    const { root, ygg } = await freshDir('nomodel');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      freshInitNonInteractive(root, ygg, { platform: 'claude-code', provider: 'claude-code' }),
    ).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.map(c => String(c[0])).join('')).toContain('--model is required');
  });

  it('exits 1 when an OpenAI-compatible provider is given no --endpoint', async () => {
    const { root, ygg } = await freshDir('noendpoint');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      freshInitNonInteractive(root, ygg, { platform: 'generic', provider: 'openai-compatible', model: 'gpt-x' }),
    ).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.map(c => String(c[0])).join('')).toContain('--endpoint is required');
  });
});
