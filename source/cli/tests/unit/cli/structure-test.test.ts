import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerStructureTestCommand } from '../../../src/cli/structure-test.js';

describe('structure-test command', () => {
  it('registers structure-test command', () => {
    const program = new Command();
    registerStructureTestCommand(program);
    expect(program.commands.map(c => c.name())).toContain('structure-test');
  });

  it('structure-test command requires --aspect and --node options', () => {
    const program = new Command();
    registerStructureTestCommand(program);
    const cmd = program.commands.find(c => c.name() === 'structure-test')!;
    const options = cmd.options.map(o => o.long);
    expect(options).toContain('--aspect');
    expect(options).toContain('--node');
  });
});
