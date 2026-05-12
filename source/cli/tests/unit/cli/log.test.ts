import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerLogCommand } from '../../../src/cli/log.js';

describe('registerLogCommand', () => {
  it('registers yg log with subcommands add, read, merge-resolve', () => {
    const program = new Command();
    registerLogCommand(program);
    const log = program.commands.find((c) => c.name() === 'log');
    expect(log).toBeDefined();
    const sub = (log!.commands ?? []).map((c) => c.name()).sort();
    expect(sub).toEqual(['add', 'merge-resolve', 'read']);
  });
});
