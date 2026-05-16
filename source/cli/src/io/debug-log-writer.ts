import { appendFileSync } from 'node:fs';

export function appendToDebugLog(filePath: string, text: string): void {
  appendFileSync(filePath, text, 'utf-8');
}
