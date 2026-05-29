import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerTreeCommand } from '../../../src/cli/tree.js';

describe('tree command', () => {
  it('registers tree command', () => {
    const program = new Command();
    registerTreeCommand(program);
    expect(program.commands.map(c => c.name())).toContain('tree');
  });

  it('tree command exposes --root and --depth options', () => {
    const program = new Command();
    registerTreeCommand(program);
    const cmd = program.commands.find(c => c.name() === 'tree')!;
    const options = cmd.options.map(o => o.long);
    expect(options).toContain('--root');
    expect(options).toContain('--depth');
  });
});
