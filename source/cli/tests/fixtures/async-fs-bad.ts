import fs from 'node:fs';

export function readConfig(path: string): string {
  return fs.readFileSync(path, 'utf-8'); // synchronous — should be flagged
}
