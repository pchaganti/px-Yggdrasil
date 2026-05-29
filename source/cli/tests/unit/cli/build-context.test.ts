import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerBuildCommand } from '../../../src/cli/build-context.js';

describe('build-context command', () => {
  it('registers context command', () => {
    const program = new Command();
    registerBuildCommand(program);
    expect(program.commands.map(c => c.name())).toContain('context');
  });

  it('context command exposes --node and --file options', () => {
    const program = new Command();
    registerBuildCommand(program);
    const cmd = program.commands.find(c => c.name() === 'context')!;
    const options = cmd.options.map(o => o.long);
    expect(options).toContain('--node');
    expect(options).toContain('--file');
  });
});
