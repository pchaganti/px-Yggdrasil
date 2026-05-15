import * as workingWithArchitecture from './working-with-architecture.js';
import * as aspectsOverview from './aspects-overview.js';
import * as writingLlmAspects from './writing-llm-aspects.js';
import * as writingAstAspects from './writing-ast-aspects.js';
import * as conditionalAspects from './conditional-aspects.js';
import * as suppressSyntax from './suppress-syntax.js';
import * as driftAndCascade from './drift-and-cascade.js';
import * as configuration from './configuration.js';
import * as cliReference from './cli-reference.js';
import * as logManagement from './log-management.js';
import * as portsAndRelations from './ports-and-relations.js';
import * as flows from './flows.js';

export type KnowledgeTopic = {
  summary: string;
  content: string;
};

export const KNOWLEDGE_TOPICS: Record<string, KnowledgeTopic> = {
  'working-with-architecture': {
    summary: workingWithArchitecture.summary,
    content: workingWithArchitecture.content,
  },
  'aspects-overview': {
    summary: aspectsOverview.summary,
    content: aspectsOverview.content,
  },
  'writing-llm-aspects': {
    summary: writingLlmAspects.summary,
    content: writingLlmAspects.content,
  },
  'writing-ast-aspects': {
    summary: writingAstAspects.summary,
    content: writingAstAspects.content,
  },
  'conditional-aspects': {
    summary: conditionalAspects.summary,
    content: conditionalAspects.content,
  },
  'suppress-syntax': {
    summary: suppressSyntax.summary,
    content: suppressSyntax.content,
  },
  'drift-and-cascade': {
    summary: driftAndCascade.summary,
    content: driftAndCascade.content,
  },
  configuration: {
    summary: configuration.summary,
    content: configuration.content,
  },
  'cli-reference': {
    summary: cliReference.summary,
    content: cliReference.content,
  },
  'log-management': {
    summary: logManagement.summary,
    content: logManagement.content,
  },
  'ports-and-relations': {
    summary: portsAndRelations.summary,
    content: portsAndRelations.content,
  },
  flows: {
    summary: flows.summary,
    content: flows.content,
  },
};
