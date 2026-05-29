import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerInitCommand } from '../../../src/cli/init.js';

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
});
