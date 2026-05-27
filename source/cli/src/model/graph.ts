import type { WhenPredicate } from './when.js';
import type { FileWhenPredicate } from './file-when.js';
import type { IssueMessage } from './validation.js';

export type {
  WhenPredicate,
  BooleanClause,
  AtomicClause,
  RelationClause,
  RelationMatch,
  DescendantsClause,
  NodeClause,
} from './when.js';
export type { FileWhenPredicate } from './file-when.js';

// ============================================================
// ReviewerConfig — v5 reviewer.tiers structure
// ============================================================

export interface ReviewerConfig {
  /** Tier name used when an aspect doesn't declare one explicitly */
  default?: string;
  /** At least one entry required; key is the tier name */
  tiers: Record<string, LlmConfig>;
}

// ============================================================
// Config
// ============================================================

export interface YggConfig {
  version?: string;
  quality?: QualityConfig;
  /** v5 reviewer configuration — tiers + default. Optional in the type
   *  to preserve FALLBACK_CONFIG ergonomics; validator emits
   *  `config-reviewer-missing` when absent on a real project. */
  reviewer?: ReviewerConfig;
  parallel?: number;
  debug?: boolean;
}

// ============================================================
// Architecture
// ============================================================

export interface ArchitectureNodeType {
  description: string;
  aspects?: string[];
  /** Per-aspect applicability filters for aspects listed in `aspects` */
  aspectWhens?: Record<string, WhenPredicate>;
  parents?: string[];
  relations?: Partial<Record<RelationType, string[]>>;
  /**
   * Whether nodes of this type require a log entry per source-file change.
   * Undefined means caller should apply its own default (typically true).
   */
  log_required?: boolean;
  /**
   * Per-file classification predicate. Types without `when` are organizational
   * (parent-only — nodes of that type cannot carry a non-empty `mapping:`).
   */
  when?: FileWhenPredicate;
  /**
   * When set to 'strict', backward enforcement applies: any repo file matching
   * `when` must be in a node mapping of this type, and conversely a mapping
   * file must satisfy `when`.
   */
  enforce?: 'strict';
}

export interface ArchitectureDef {
  node_types: Record<string, ArchitectureNodeType>;
}

export interface QualityConfig {
  max_direct_relations: number;
  max_mapping_source_files?: number;
}

// ============================================================
// Node
// ============================================================

export type RelationType = 'uses' | 'calls' | 'extends' | 'implements' | 'emits' | 'listens';

/** Port on a target node — consumers must satisfy port's aspects */
export interface PortDef {
  description: string;
  aspects: string[];
  /** Per-aspect applicability filters for aspects listed in `aspects` */
  aspectWhens?: Record<string, WhenPredicate>;
}

export type ReviewerProvider =
  // API
  | 'ollama' | 'openai' | 'anthropic' | 'google' | 'openai-compatible'
  // CLI
  | 'claude-code' | 'codex' | 'gemini-cli';

/** LLM configuration — merged from yg-config.yaml + yg-secrets.yaml */
export interface LlmConfig {
  provider: ReviewerProvider;
  model: string;
  endpoint?: string;
  api_key?: string;
  temperature: number;
  consensus: number;
  max_tokens: number | 'auto';
  /** Ollama model_info key for context length (e.g. "qwen35.context_length"). Auto-detected if omitted. */
  context_length_field?: string;
  /** CLI providers: subprocess timeout in ms. Default: 120_000. */
  timeout?: number;
}

export interface NodeMeta {
  name: string;
  type: string;
  description?: string;
  aspects?: string[];
  /** Per-aspect applicability filters for aspects listed in `aspects` */
  aspectWhens?: Record<string, WhenPredicate>;
  ports?: Record<string, PortDef>;
  relations?: Relation[];
  /** Flat list of file/directory paths relative to repo root */
  mapping?: string[];
}

export interface Relation {
  target: string;
  type: RelationType;
  consumes?: string[];
  /** For event relations (emits, listens): display name of the event, e.g. OrderPlaced */
  event_name?: string;
}

export interface GraphNode {
  /** Path relative to model/, e.g. "orders/order-service" */
  path: string;
  /** Parsed yg-node.yaml content */
  meta: NodeMeta;
  /** Raw yg-node.yaml file content (for context assembly without disk access) */
  nodeYamlRaw?: string;
  /** Child nodes (subdirectories with yg-node.yaml) */
  children: GraphNode[];
  /** Parent node (null for top-level nodes) */
  parent: GraphNode | null;
}

export interface Artifact {
  /** Filename, e.g. "content.md" */
  filename: string;
  /** Full text content of the file */
  content: string;
}

// ============================================================
// AspectReviewerSpec — per-aspect reviewer choice + tier
// ============================================================

export interface AspectReviewerSpec {
  type: 'llm' | 'ast';
  /** Tier reference into ReviewerConfig.tiers; valid only when type === 'llm' */
  tier?: string;
}

// ============================================================
// Aspect
// ============================================================

export interface AspectDef {
  name: string;
  id: string;
  description?: string;
  /** Reviewer specification — type and optional tier reference */
  reviewer: AspectReviewerSpec;
  /** Target languages for AST aspects (required). Optional for LLM aspects with registry-membership check. */
  language?: string[];
  implies?: string[];
  /** Per-implies applicability filters for aspect ids listed in `implies` */
  impliesWhens?: Record<string, WhenPredicate>;
  /** Global applicability filter for this aspect, applied on every channel */
  when?: WhenPredicate;
  artifacts: Artifact[];
}

// ============================================================
// Flow
// ============================================================

export interface FlowDef {
  /** Directory name under flows/, e.g. "checkout-flow" */
  path: string;
  name: string;
  description?: string;
  nodes: string[];
  /** Optional aspect ids — aspects propagate to all participants */
  aspects?: string[];
  /** Per-aspect applicability filters for aspects listed in `aspects` */
  aspectWhens?: Record<string, WhenPredicate>;
}

// ============================================================
// Schema (graph layer reference, lives in schemas/)
// ============================================================

export interface SchemaDef {
  /** Inferred from filename: 'node' | 'aspect' | 'flow' */
  schemaType: string;
}

// ============================================================
// Graph (top-level)
// ============================================================

/**
 * Architecture file load error.
 *
 * Bare string keeps backward compatibility with legacy parse failures.
 * Structured form lets validators distinguish error codes — e.g.
 * `when-predicate-invalid` (Spec §7 Klasa 6) vs. generic `architecture-invalid`.
 */
export type ArchitectureLoadError =
  | { code: 'architecture-invalid'; messageData: IssueMessage }
  | { code: 'when-predicate-invalid'; message: string };

export interface Graph {
  config: YggConfig;
  architecture: ArchitectureDef;
  /** Present when yg-architecture.yaml could not be parsed */
  architectureError?: ArchitectureLoadError;
  /** Present when yg-config.yaml could not be parsed and loader used fallback config */
  configError?: string;
  /** Parse errors for yg-node.yaml files; reported as yaml-invalid */
  nodeParseErrors?: Array<{ nodePath: string; messageData: IssueMessage }>;
  /** Parse errors for yg-aspect.yaml files. Each carries the structured
   *  validator code (e.g. 'aspect-reviewer-legacy-string') for the
   *  validator to emit downstream. */
  aspectParseErrors?: Array<{
    aspectId: string;
    code: string;
    messageData: IssueMessage;
  }>;

  /** Structured error code carried alongside `configError`. Used by
   *  validator to suppress dependent checks (e.g., when config is in
   *  legacy format, skip aspect-tier-unknown). */
  configErrorCode?: string;
  /** All nodes indexed by their path (e.g. "orders/order-service") */
  nodes: Map<string, GraphNode>;
  aspects: AspectDef[];
  flows: FlowDef[];
  schemas: SchemaDef[];
  /** Absolute path to the .yggdrasil/ directory */
  rootPath: string;
}

// ============================================================
// Owner
// ============================================================

export interface OwnerResult {
  file: string;
  nodePath: string | null;
  mappingPath?: string;
  /** When false, file has no direct mapping; coverage comes from ancestor directory */
  direct?: boolean;
}
