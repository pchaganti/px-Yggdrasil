import type { Migration } from '../core/migrator.js';

// B4 deletion sweep: legacy migration files removed. MIGRATIONS is empty; the
// graph is now at the schema version that the verdict-lock redesign targets.
export const MIGRATIONS: Migration[] = [];
