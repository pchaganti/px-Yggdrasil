import type { Migration } from '../core/migrator.js';
import { migration as to_5_1_0 } from './to-5.1.0.js';

export const MIGRATIONS: Migration[] = [to_5_1_0];
