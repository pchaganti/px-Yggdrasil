import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerAstTestCommand } from '../../../src/cli/ast-test.js';

describe('ast-test command', () => {
  it('registers ast-test command', () => {
    const program = new Command();
    registerAstTestCommand(program);
    expect(program.commands.map(c => c.name())).toContain('ast-test');
  });

  it('ast-test command requires --aspect option', () => {
    const program = new Command();
    registerAstTestCommand(program);
    const cmd = program.commands.find(c => c.name() === 'ast-test')!;
    const options = cmd.options.map(o => o.long);
    expect(options).toContain('--aspect');
  });
});
