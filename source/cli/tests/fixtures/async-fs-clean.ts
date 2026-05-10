import fs from 'node:fs/promises';

export async function readConfig(path: string): Promise<string> {
  return fs.readFile(path, 'utf-8'); // async — OK
}
