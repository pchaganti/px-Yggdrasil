import * as node from './node.js';
import * as aspect from './aspect.js';
import * as architecture from './architecture.js';
import * as config from './config.js';
import * as flow from './flow.js';

export type SchemaTopic = {
  summary: string;
  content: string;
};

export const SCHEMA_TOPICS: Record<string, SchemaTopic> = {
  node: {
    summary: node.summary,
    content: node.content,
  },
  aspect: {
    summary: aspect.summary,
    content: aspect.content,
  },
  architecture: {
    summary: architecture.summary,
    content: architecture.content,
  },
  config: {
    summary: config.summary,
    content: config.content,
  },
  flow: {
    summary: flow.summary,
    content: flow.content,
  },
};
