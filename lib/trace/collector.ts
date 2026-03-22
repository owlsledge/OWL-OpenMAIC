/**
 * TraceCollector — observes a StatelessEvent stream and builds a TraceRecord.
 *
 * Usage in the chat route:
 *
 *   const collector = new TraceCollector(request, modelString);
 *
 *   for await (const event of statelessGenerate(...)) {
 *     collector.observe(event);   // build trace state
 *     yield event;                // pass through to SSE client unchanged
 *   }
 *
 *   if (aborted) collector.markAborted();
 *   const record = collector.finalize();
 *
 * The collector is purely observational — it never modifies or drops events.
 */

import { randomUUID } from 'crypto';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type {
  TraceRecord,
  TraceContext,
  TraceDirectorDecision,
  TraceAgentTurn,
  TraceAction,
  TraceOutcome,
} from './schema';
import { TRACE_SCHEMA_VERSION } from './schema';

export class TraceCollector {
  private readonly requestId: string;
  private readonly requestedAt: string;
  private readonly model: string;
  private readonly context: TraceContext;

  // ── Director tracking ──────────────────────────────────────────────────────
  /** true if we saw thinking{stage:'director'} → LLM was called */
  private sawDirectorThinking = false;
  /** true if we saw thinking{stage:'agent_loading'} → an agent was chosen */
  private sawAgentLoading = false;
  private selectedAgentId?: string;
  private directorOutcome?: TraceDirectorDecision['outcome'];

  // ── Agent turn tracking ────────────────────────────────────────────────────
  private agentMeta?: {
    agentId: string;
    agentName: string;
    agentAvatar?: string;
    agentColor?: string;
    messageId: string;
    startedAt: string;
    startMs: number;
  };
  private textChunks: string[] = [];
  private actions: TraceAction[] = [];
  private actionSequenceIndex = 0;
  private completedAgentTurn?: TraceAgentTurn;

  // ── Outcome tracking ───────────────────────────────────────────────────────
  private outcome?: TraceOutcome;
  private error?: string;
  private completedAt?: string;

  constructor(request: StatelessChatRequest, model: string) {
    this.requestId = randomUUID();
    this.requestedAt = new Date().toISOString();
    this.model = model;
    this.context = buildContext(request);
  }

  // ==================== Public API ====================

  /** Feed one StatelessEvent into the collector. Call for every event in the stream. */
  observe(event: StatelessEvent): void {
    switch (event.type) {
      case 'thinking':
        if (event.data.stage === 'director') {
          this.sawDirectorThinking = true;
        } else if (event.data.stage === 'agent_loading') {
          this.sawAgentLoading = true;
          this.selectedAgentId = event.data.agentId;
        }
        break;

      case 'cue_user':
        this.directorOutcome = 'cue_user';
        this.outcome = 'cue_user';
        this.completedAt = new Date().toISOString();
        break;

      case 'agent_start':
        this.directorOutcome = 'dispatch';
        this.agentMeta = {
          agentId: event.data.agentId,
          agentName: event.data.agentName,
          agentAvatar: event.data.agentAvatar,
          agentColor: event.data.agentColor,
          messageId: event.data.messageId,
          startedAt: new Date().toISOString(),
          startMs: Date.now(),
        };
        break;

      case 'text_delta':
        if (this.agentMeta) {
          this.textChunks.push(event.data.content);
        }
        break;

      case 'action':
        if (this.agentMeta) {
          const action: TraceAction = {
            actionId: event.data.actionId,
            actionType: event.data.actionName,
            sequenceIndex: this.actionSequenceIndex++,
            params: event.data.params,
          };
          if (event.data.actionName === 'speech' && typeof event.data.params.text === 'string') {
            action.speechTextLength = event.data.params.text.length;
          }
          if (
            event.data.actionName.startsWith('wb_') &&
            typeof event.data.params.elementId === 'string'
          ) {
            action.whiteboardElementId = event.data.params.elementId;
          }
          this.actions.push(action);
        }
        break;

      case 'agent_end':
        if (this.agentMeta) {
          const completedAt = new Date().toISOString();
          const textContent = this.textChunks.join('');
          this.completedAgentTurn = {
            agentId: this.agentMeta.agentId,
            agentName: this.agentMeta.agentName,
            agentAvatar: this.agentMeta.agentAvatar,
            agentColor: this.agentMeta.agentColor,
            messageId: this.agentMeta.messageId,
            startedAt: this.agentMeta.startedAt,
            completedAt,
            durationMs: Date.now() - this.agentMeta.startMs,
            textContent,
            textLength: textContent.length,
            actions: this.actions,
            actionCount: this.actions.length,
          };
          this.outcome = 'agent_dispatched';
        }
        break;

      case 'done':
        this.completedAt = new Date().toISOString();
        // If no outcome was set yet, the director ended without dispatching
        if (!this.outcome) {
          this.outcome = 'turn_limit';
          this.directorOutcome = 'turn_limit';
        }
        break;

      case 'error':
        this.error = event.data.message;
        this.outcome = 'error';
        this.completedAt = new Date().toISOString();
        break;
    }
  }

  /** Call this if the HTTP request was aborted before the stream completed. */
  markAborted(): void {
    this.outcome = 'aborted';
    this.completedAt = new Date().toISOString();
  }

  /**
   * Build the final TraceRecord from all observed events.
   * Safe to call multiple times — returns a new object each time.
   */
  finalize(): TraceRecord {
    const completedAt = this.completedAt ?? new Date().toISOString();
    const requestedMs = new Date(this.requestedAt).getTime();
    const durationMs = new Date(completedAt).getTime() - requestedMs;

    const directorDecision: TraceDirectorDecision = {
      strategy: this.inferStrategy(),
      selectedAgentId: this.selectedAgentId,
      outcome: this.directorOutcome ?? 'end',
    };

    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      requestId: this.requestId,
      recordedAt: new Date().toISOString(),
      requestedAt: this.requestedAt,
      completedAt,
      durationMs,
      model: this.model,
      context: this.context,
      directorDecision,
      agentTurn: this.completedAgentTurn,
      outcome: this.outcome ?? 'aborted',
      error: this.error,
    };
  }

  // ==================== Private helpers ====================

  /**
   * Infer which director strategy was used from the observed event sequence:
   *
   *   sawDirectorThinking            → 'llm'
   *   sawAgentLoading, single agent  → 'code_single_agent'
   *   sawAgentLoading, multi agent   → 'code_fast_path'
   *   neither (turn limit / error)   → 'turn_limit'
   */
  private inferStrategy(): TraceDirectorDecision['strategy'] {
    if (this.sawDirectorThinking) return 'llm';
    if (this.sawAgentLoading) {
      return this.context.availableAgentIds.length <= 1 ? 'code_single_agent' : 'code_fast_path';
    }
    return 'turn_limit';
  }
}

// ==================== Helpers ====================

function buildContext(request: StatelessChatRequest): TraceContext {
  const { storeState, config, directorState } = request;

  const currentScene = storeState.currentSceneId
    ? (storeState.scenes as Array<{ id: string; type: string; title?: string }>).find(
        (s) => s.id === storeState.currentSceneId,
      )
    : undefined;

  return {
    turnCount: directorState?.turnCount ?? 0,
    availableAgentIds: config.agentIds,
    triggerAgentId: config.triggerAgentId,
    sessionType: config.sessionType,
    scene: currentScene
      ? {
          sceneId: currentScene.id,
          sceneType: currentScene.type,
          sceneTitle: currentScene.title,
        }
      : undefined,
  };
}
