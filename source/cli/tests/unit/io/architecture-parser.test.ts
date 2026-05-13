import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseArchitecture } from '../../../src/io/architecture-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('parseArchitecture', () => {
  async function writeTmp(fileName: string, content: string): Promise<string> {
    const tmpDir = path.join(__dirname, `../../fixtures/tmp-arch-${Date.now()}-${Math.random()}`);
    await mkdir(tmpDir, { recursive: true });
    const file = path.join(tmpDir, fileName);
    await writeFile(file, content, 'utf-8');
    return file;
  }

  async function cleanup(file: string): Promise<void> {
    const dir = path.dirname(file);
    await rm(dir, { recursive: true, force: true });
  }

  it('parses minimal architecture with only descriptions', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  module:
    description: "Business logic unit"
  service:
    description: "Request handler"
`);
    const arch = await parseArchitecture(file);
    expect(arch.node_types.module.description).toBe('Business logic unit');
    expect(arch.node_types.service.description).toBe('Request handler');
    expect(arch.node_types.module.aspects).toBeUndefined();
    await cleanup(file);
  });

  it('parses full architecture with all constraints', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "Request handler"
    aspects: [requires-auth, error-format]
    parents: [module]
    relations:
      calls: [service, library]
      uses: [library]
`);
    const arch = await parseArchitecture(file);
    const svc = arch.node_types.service;
    expect(svc.aspects).toEqual(['requires-auth', 'error-format']);
    expect(svc.parents).toEqual(['module']);
    expect(svc.relations?.calls).toEqual(['service', 'library']);
    expect(svc.relations?.uses).toEqual(['library']);
    await cleanup(file);
  });

  it('accepts file with no node_types field as empty', async () => {
    const file = await writeTmp('yg-architecture.yaml', `name: test`);
    const arch = await parseArchitecture(file);
    expect(arch.node_types).toEqual({});
    await cleanup(file);
  });

  it('throws on missing description', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    aspects: [foo]
`);
    await expect(parseArchitecture(file)).rejects.toThrow('description');
    await cleanup(file);
  });

  it('throws on invalid relation type', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      depends: [library]
`);
    await expect(parseArchitecture(file)).rejects.toThrow('relation type');
    await cleanup(file);
  });

  it('parses all valid relation types', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      uses: [library]
      calls: [service]
      extends: [base]
      implements: [interface]
      emits: [event]
      listens: [event]
`);
    const arch = await parseArchitecture(file);
    const rels = arch.node_types.service.relations;
    expect(rels?.uses).toEqual(['library']);
    expect(rels?.calls).toEqual(['service']);
    expect(rels?.extends).toEqual(['base']);
    expect(rels?.implements).toEqual(['interface']);
    expect(rels?.emits).toEqual(['event']);
    expect(rels?.listens).toEqual(['event']);
    await cleanup(file);
  });

  it('parses empty relations object', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations: {}
`);
    const arch = await parseArchitecture(file);
    const rels = arch.node_types.service.relations;
    expect(rels).toEqual({});
    await cleanup(file);
  });

  it('throws on non-array relation value', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      uses: "library"
`);
    await expect(parseArchitecture(file)).rejects.toThrow('array');
    await cleanup(file);
  });

  it('accepts empty file as empty node_types', async () => {
    const file = await writeTmp('yg-architecture.yaml', '');
    const arch = await parseArchitecture(file);
    expect(arch.node_types).toEqual({});
    await cleanup(file);
  });

  it('accepts empty node_types object', async () => {
    const file = await writeTmp('yg-architecture.yaml', 'node_types: {}\n');
    const arch = await parseArchitecture(file);
    expect(arch.node_types).toEqual({});
    await cleanup(file);
  });

  it('accepts null node_types value', async () => {
    const file = await writeTmp('yg-architecture.yaml', 'node_types:\n');
    const arch = await parseArchitecture(file);
    expect(arch.node_types).toEqual({});
    await cleanup(file);
  });

  it('accepts commented-only architecture file', async () => {
    const file = await writeTmp('yg-architecture.yaml', '# commented placeholder\n');
    const arch = await parseArchitecture(file);
    expect(arch.node_types).toEqual({});
    await cleanup(file);
  });

  it('rejects top-level YAML array', async () => {
    const file = await writeTmp('yg-architecture.yaml', '- foo\n- bar\n');
    await expect(parseArchitecture(file)).rejects.toThrow(/mapping/);
    await cleanup(file);
  });

  it('rejects node_types as array', async () => {
    const file = await writeTmp('yg-architecture.yaml', 'node_types:\n  - service\n');
    await expect(parseArchitecture(file)).rejects.toThrow(/mapping/);
    await cleanup(file);
  });

  it('allows node_types with only description (minimal valid entry)', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  module:
    description: "unit"
  service:
    description: "handler"
  library:
    description: "utility"
`);
    const arch = await parseArchitecture(file);
    expect(Object.keys(arch.node_types)).toHaveLength(3);
    expect(arch.node_types.module.description).toBe('unit');
    expect(arch.node_types.service.description).toBe('handler');
    expect(arch.node_types.library.description).toBe('utility');
    await cleanup(file);
  });

  it('parses object form in node_types.*.aspects with when', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  command:
    description: "A command"
    aspects:
      - simple-aspect
      - id: conditional-aspect
        when:
          relations: { calls: { target_type: service-client } }
`);
    const result = await parseArchitecture(file);
    expect(result.node_types.command.aspects).toEqual(['simple-aspect', 'conditional-aspect']);
    expect(result.node_types.command.aspectWhens).toEqual({
      'conditional-aspect': { relations: { calls: { target_type: 'service-client' } } },
    });
    await cleanup(file);
  });

  describe('architecture-parser v4 changes', () => {
    it('rejects integration_aspects as unknown field', async () => {
      const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "Request handler"
    aspects: [requires-auth]
    integration_aspects: [correlation-tracking]
`);
      await expect(parseArchitecture(file)).rejects.toThrow(/unknown field.*integration_aspects/i);
      await cleanup(file);
    });

    it('parses architecture without integration_aspects', async () => {
      const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "Request handler"
    aspects: [requires-auth]
    parents: [module]
`);
      const arch = await parseArchitecture(file);
      expect(arch.node_types.service.aspects).toEqual(['requires-auth']);
      expect(arch.node_types.service).not.toHaveProperty('integration_aspects');
      await cleanup(file);
    });
  });
});

describe('parseArchitecture — log_required', () => {
  async function withArchYaml<T>(yaml: string, fn: (filePath: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-arch-'));
    try {
      const filePath = path.join(dir, 'yg-architecture.yaml');
      await writeFile(filePath, yaml, 'utf-8');
      return await fn(filePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('reads log_required: true', async () => {
    const yaml = `node_types:\n  command:\n    description: CLI command handler\n    log_required: true\n`;
    await withArchYaml(yaml, async (fp) => {
      const arch = await parseArchitecture(fp);
      expect(arch.node_types.command.log_required).toBe(true);
    });
  });

  it('reads log_required: false', async () => {
    const yaml = `node_types:\n  test:\n    description: Test fixtures\n    log_required: false\n`;
    await withArchYaml(yaml, async (fp) => {
      const arch = await parseArchitecture(fp);
      expect(arch.node_types.test.log_required).toBe(false);
    });
  });

  it('leaves log_required undefined when field absent', async () => {
    const yaml = `node_types:\n  module:\n    description: Module\n`;
    await withArchYaml(yaml, async (fp) => {
      const arch = await parseArchitecture(fp);
      expect(arch.node_types.module.log_required).toBeUndefined();
    });
  });

  it('rejects log_required when not boolean', async () => {
    const yaml = `node_types:\n  module:\n    description: Module\n    log_required: "yes"\n`;
    await withArchYaml(yaml, async (fp) => {
      await expect(parseArchitecture(fp)).rejects.toThrow(/log_required.*boolean/);
    });
  });
});
