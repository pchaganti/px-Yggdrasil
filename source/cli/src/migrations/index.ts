import type { Migration } from '../core/migrator.js';
import { migrateTo4 } from './to-4.0.0.js';
import { migrateTo43 } from './to-4.3.0.js';
import { migrateTo50 } from './to-5.0.0.js';

export const MIGRATIONS: Migration[] = [
  {
    to: '4.0.0',
    description: 'Enforcement-only model: remove node/flow artifacts, flatten aspects and mapping, split architecture, reset drift state',
    run: migrateTo4,
  },
  {
    to: '4.3.0',
    description: 'Add explicit log_required: false to existing node_types; add when predicate + enforce: strict support to node_types (file classification)',
    run: migrateTo43,
  },
  {
    to: '5.0.0',
    description: 'Reviewer tiers: migrate yg-config.yaml from v4 provider sections to v5 tiers, and yg-aspect.yaml reviewer: string to reviewer: { type: ... }',
    run: migrateTo50,
  },
];
