import type { Migration } from '../core/migrator.js';
import { migrateTo4 } from './to-4.0.0.js';
import { migrateTo43 } from './to-4.3.0.js';

export const MIGRATIONS: Migration[] = [
  {
    to: '4.0.0',
    description: 'Enforcement-only model: remove node/flow artifacts, flatten aspects and mapping, split architecture, reset drift state',
    run: migrateTo4,
  },
  {
    to: '4.3.0',
    description: 'Add explicit log_required: false to existing node_types (preserves prior behaviour; new field default is true in code)',
    run: migrateTo43,
  },
];
