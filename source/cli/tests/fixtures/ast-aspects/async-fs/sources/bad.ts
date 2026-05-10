import * as fs from 'fs';

export function readConfig(path: string): string {
  return fs.readFileSync(path, 'utf-8');  // violation — sync
}
