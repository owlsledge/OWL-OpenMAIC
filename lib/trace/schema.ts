/**
 * OWL-OpenMAIC Trace Schema — v1.0.0
 *
 * A trace captures one complete stateless /api/chat request+response cycle:
 *   director decision → (optional) agent turn → completion
 *
 * Multi-turn sessions produce one TraceRecord per request. Records can be
 * linked in owl-trace-annotator by sessionId (client-supplied) or inferred
 * from proximity, agent set, and turnCount ordering.
 *
 * Output format: newline-delimited JSON (JSONL), one record per line.
 */

export const TRACE_SCHEMA_VERSION = '1.0.0' as const;

// ==================== Top-level record ====================

/**
 * One complete stateless /api/chat request+response cycle.
 * Written to disk by TraceExporter after the SSE stream closes.
 */
export interface TraceRecord {
  schemaVersion: typeof TRACE_SCHEMA_VERSION;

  /** UUID — unique per request */
  requestId: string;

  /**
   * Optional: client-supplied identifier to link records from the same
   * multi-turn session. Not set by the server (stateless API has no session
   * concept) — populated by the annotator or a future session-aware client.
   */
  sessionId?: string;

  /** ISO 8601 — when this record was written to disk */
  recordedAt: string;

  /** ISO 8601 — request start */
  requestedAt: string;

  /** ISO 8601 — request end (undefined if aborted before completion) */
  completedAt?: string;

  /** Wall-clock ms from request start to end */
  durationMs?: number;

  /** LLM model identifier used for this request (e.g. "gpt-4o-mini") */
  model: string;

  /** Snapshot of the orchestration context at request time */
  context: TraceContext;

  /** What the director decided */
  directorDecision: TraceDirectorDecision;

  /**
   * The agent turn that ran, if the director dispatched one.
   * Undefined if the director ended without dispatching (cue_user, turn_limit, error).
   */
  agentTurn?: TraceAgentTurn;

  /** High-level outcome of this request */
  outcome: TraceOutcome;

  /** Error message if outcome is 'error' */
  error?: string;
}

// ==================== Context ====================

/** Orchestration context captured from the incoming request */
export interface TraceContext {
  /** Director turn counter at the start of this request */
  turnCount: number;

  /** Agent IDs available to the director */
  availableAgentIds: string[];

  /** For discussions: the agent that should speak first */
  triggerAgentId?: string;

  /** Session modality */
  sessionType?: 'qa' | 'discussion';

  /** The slide/scene the classroom was on when this request was made */
  scene?: TraceSceneContext;
}

export interface TraceSceneContext {
  sceneId: string;
  /** 'slide' | 'quiz' | 'interactive' | 'pbl' */
  sceneType: string;
  sceneTitle?: string;
}

// ==================== Director Decision ====================

export interface TraceDirectorDecision {
  /**
   * Which strategy the director used:
   * - code_single_agent  Single agent present; pure code dispatch, no LLM
   * - code_fast_path     First turn with triggerAgentId; LLM skipped
   * - llm                Director called the LLM to choose next agent
   * - turn_limit         Turn limit hit before any decision was made
   */
  strategy: 'code_single_agent' | 'code_fast_path' | 'llm' | 'turn_limit';

  /** The agent ID the director chose (undefined for end/cue_user outcomes) */
  selectedAgentId?: string;

  /**
   * - dispatch    An agent was dispatched
   * - end         Director decided to end the session
   * - cue_user    Director handed the floor back to the user
   * - turn_limit  Max turns reached
   */
  outcome: 'dispatch' | 'end' | 'cue_user' | 'turn_limit';
}

// ==================== Agent Turn ====================

/** The complete output of one agent invocation */
export interface TraceAgentTurn {
  agentId: string;
  agentName: string;
  agentAvatar?: string;
  agentColor?: string;

  /** Message ID assigned by the server (assistant-{agentId}-{timestamp}) */
  messageId: string;

  /** ISO 8601 — when agent_start was received */
  startedAt: string;

  /** ISO 8601 — when agent_end was received */
  completedAt?: string;

  /** Wall-clock ms from agent_start to agent_end */
  durationMs?: number;

  /** Full assembled text (all text_delta chunks concatenated) */
  textContent: string;

  /** Character count of textContent */
  textLength: number;

  /** All actions emitted by this agent, in emission order */
  actions: TraceAction[];

  /** Total number of actions (= actions.length) */
  actionCount: number;

  /**
   * Annotation fields — populated by owl-trace-annotator, not by this exporter.
   * Kept here so annotated JSONL files stay self-contained.
   */
  annotations?: TraceAnnotations;
}

// ==================== Actions ====================

/** One action emitted by an agent during a turn */
export interface TraceAction {
  /** Action ID from the structured output */
  actionId: string;

  /**
   * Action type string — matches ActionType union:
   * 'speech' | 'spotlight' | 'laser' | 'play_video' |
   * 'wb_open' | 'wb_draw_text' | 'wb_draw_shape' | 'wb_draw_chart' |
   * 'wb_draw_latex' | 'wb_draw_table' | 'wb_draw_line' |
   * 'wb_clear' | 'wb_delete' | 'wb_close' | 'discussion'
   */
  actionType: string;

  /** Position of this action within the turn (0-indexed, emission order) */
  sequenceIndex: number;

  /** Raw params as parsed from the structured output */
  params: Record<string, unknown>;

  // ── Derived convenience fields ──

  /** Character count of params.text (only set for 'speech' actions) */
  speechTextLength?: number;

  /** params.elementId (set for wb_* actions that reference an element) */
  whiteboardElementId?: string;
}

// ==================== Outcome ====================

export type TraceOutcome =
  /** Director dispatched an agent and it produced a response */
  | 'agent_dispatched'
  /** Director handed the floor back to the user */
  | 'cue_user'
  /** Turn limit was reached before an agent could be dispatched */
  | 'turn_limit'
  /** An error occurred during director or agent execution */
  | 'error'
  /** Client aborted the SSE stream before completion */
  | 'aborted';

// ==================== Annotations ====================

/**
 * Free-form annotation fields added by owl-trace-annotator.
 * Not written by this exporter — present here so annotated files
 * remain schema-compliant and can be validated.
 */
export interface TraceAnnotations {
  /** Human quality rating */
  quality?: 'good' | 'ok' | 'bad';
  /** Free-text reviewer notes */
  notes?: string;
  /** Categorical labels (e.g. 'hallucination', 'off-topic', 'good-analogy') */
  tags?: string[];
  /** Extension point for custom annotation fields */
  [key: string]: unknown;
}
