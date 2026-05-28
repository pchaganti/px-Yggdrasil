import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlow } from '../../../src/io/flow-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, '../../fixtures/tmp-flow-status');

async function writeFlowFixture(yaml: string): Promise<{ flowDir: string; yamlPath: string }> {
  const flowDir = path.join(TMP, 'example-flow');
  await mkdir(flowDir, { recursive: true });
  const yamlPath = path.join(flowDir, 'yg-flow.yaml');
  await writeFile(yamlPath, yaml, 'utf-8');
  return { flowDir, yamlPath };
}

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe('flow-parser: aspect status', () => {
  it('bare aspect → no status override', async () => {
    const { flowDir, yamlPath } = await writeFlowFixture(`
name: Ex
description: x
nodes: [a, b]
aspects:
  - correlation
`);
    const flow = await parseFlow(flowDir, yamlPath);
    expect(flow.aspects).toEqual(['correlation']);
    expect(flow.aspectStatus).toBeUndefined();
  });

  it('object form with status', async () => {
    const { flowDir, yamlPath } = await writeFlowFixture(`
name: Ex
description: x
nodes: [a, b]
aspects:
  - id: correlation
    status: enforced
`);
    const flow = await parseFlow(flowDir, yamlPath);
    expect(flow.aspectStatus?.['correlation']).toBe('enforced');
  });
});
