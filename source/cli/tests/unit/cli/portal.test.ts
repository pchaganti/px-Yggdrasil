import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerPortalCommand } from '../../../src/cli/portal.js';

describe('portal command', () => {
  it('registers portal command', () => {
    const program = new Command();
    registerPortalCommand(program);
    expect(program.commands.map((c) => c.name())).toContain('portal');
  });

  it('portal command exposes --static, --port, --open, --no-write options', () => {
    const program = new Command();
    registerPortalCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'portal')!;
    const options = cmd.options.map((o) => o.long);
    expect(options).toContain('--static');
    expect(options).toContain('--port');
    expect(options).toContain('--open');
    expect(options).toContain('--no-write');
  });

  it('rejects a non-integer --port value', async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    registerPortalCommand(program);
    await expect(
      program.parseAsync(['portal', '--port', 'abc'], { from: 'user' }),
    ).rejects.toThrow(/--port must be an integer/);
  });

  it('rejects an out-of-range --port value', async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    registerPortalCommand(program);
    await expect(
      program.parseAsync(['portal', '--port', '99999'], { from: 'user' }),
    ).rejects.toThrow(/--port must be an integer/);
  });
});
