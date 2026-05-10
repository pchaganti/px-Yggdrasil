import { promises as fs } from 'fs';

export async function readConfig(path: string): Promise<string> {
  return fs.readFile(path, 'utf-8');  // OK — async
}
