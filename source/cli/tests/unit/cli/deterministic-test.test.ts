import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerDeterministicTestCommand } from '../../../src/cli/deterministic-test.js';

describe('registerDeterministicTestCommand', () => {
  function findCommand(program: Command, name: string) {
    return program.commands.find((c) => c.name() === name);
  }

  it('registers a deterministic-test command', () => {
    const program = new Command();
    registerDeterministicTestCommand(program);
    const cmd = findCommand(program, 'deterministic-test');
    expect(cmd).toBeDefined();
  });

  it('exposes --aspect, --node, --files, and --check-determinism options', () => {
    const program = new Command();
    registerDeterministicTestCommand(program);
    const cmd = findCommand(program, 'deterministic-test')!;
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain('--aspect');
    expect(flags).toContain('--node');
    expect(flags).toContain('--files');
    expect(flags).toContain('--check-determinism');
  });

  it('requires the --aspect option', () => {
    const program = new Command();
    registerDeterministicTestCommand(program);
    const cmd = findCommand(program, 'deterministic-test')!;
    const aspectOpt = cmd.options.find((o) => o.long === '--aspect');
    expect(aspectOpt?.required).toBe(true);
  });
});
