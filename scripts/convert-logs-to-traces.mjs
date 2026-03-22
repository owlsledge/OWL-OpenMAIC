#!/usr/bin/env node
/**
 * convert-logs-to-traces.mjs
 *
 * Converts OWL-OpenMAIC plain-text server logs into TraceRecord JSONL.
 *
 * Usage:
 *   node scripts/convert-logs-to-traces.mjs server.log [output.jsonl]
 *   node scripts/convert-logs-to-traces.mjs server.log          # writes to stdout
 *   cat server.log | node scripts/convert-logs-to-traces.mjs -  # stdin → stdout
 *
 * Fidelity note — log-converted records have reduced detail vs live traces:
 *   - agentTurn.textContent is empty (speech text is not logged)
 *   - agentTurn.actions is [] (individual action params are not logged)
 *   - agentTurn.actionCount IS set (from "Completed. Actions: N")
 *   - scene context is absent (not logged)
 *   - agentTurn timestamps are approximated from director log timestamps
 *   - _fromLogs: true is added to each record as a provenance marker
 *
 * Log line format produced by lib/logger.ts:
 *   [ISO-TIMESTAMP] [LEVEL] [TAG] message
 *
 * HTTP response lines (from Next.js) have no timestamp prefix:
 *    POST /api/chat 200 in 6.4s (compile: ..., render: ...)
 */

import { createReadStream, createWriteStream } from 'fs';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';

const SCHEMA_VERSION = '1.0.0';

// ── Log line patterns ─────────────────────────────────────────────────────────

/** Matches structured log lines from lib/logger.ts */
const RE_LOG = /^\[(\d{4}-\d{2}-\d{2}T[\d:.Z]+)\] \[(INFO|WARN|ERROR)\] \[([^\]]+)\] (.+)$/;

/** Matches Next.js HTTP response lines: "  POST /api/chat 200 in 6.4s (...)" */
const RE_HTTP = /^\s*POST \/api\/chat (\d+) in ([\d.]+)(ms|s)/;

// ── Line parsing ──────────────────────────────────────────────────────────────

function parseLine(raw) {
  const log = RE_LOG.exec(raw);
  if (log) {
    return { kind: 'log', timestamp: log[1], level: log[2], tag: log[3], message: log[4] };
  }
  const http = RE_HTTP.exec(raw);
  if (http) {
    const value = parseFloat(http[2]);
    const durationMs = http[3] === 's' ? value * 1000 : value;
    return { kind: 'http', status: parseInt(http[1]), durationMs };
  }
  return null;
}

// ── Block grouping ────────────────────────────────────────────────────────────

/**
 * Split the flat line list into request blocks.
 * A block is everything from one "[Chat API] Processing request" to the next.
 * This ensures abort log lines (which follow the HTTP line) stay in their block.
 */
function groupIntoBlocks(lines) {
  const blocks = [];
  let current = null;

  for (const raw of lines) {
    const parsed = parseLine(raw);
    if (!parsed) continue;

    if (
      parsed.kind === 'log' &&
      parsed.tag === 'Chat API' &&
      parsed.message === 'Processing request'
    ) {
      if (current) blocks.push(current);
      current = { startTimestamp: parsed.timestamp, parsed: [parsed] };
    } else if (current) {
      current.parsed.push(parsed);
    }
  }
  if (current) blocks.push(current);

  return blocks;
}

// ── Field extractors ──────────────────────────────────────────────────────────

/**
 * Parse: "Agents: default-1, default-2, Messages: 3, Turn: 0"
 * Returns { agentIds, messageCount, turnCount } or null.
 */
function parseAgentsLine(msg) {
  const boundary = msg.indexOf(', Messages:');
  if (boundary < 0) return null;
  const agentsPart = msg.slice('Agents: '.length, boundary);
  const rest = msg.slice(boundary);
  const agents = agentsPart.split(', ').map((s) => s.trim()).filter(Boolean);
  const msgMatch = /Messages: (\d+)/.exec(rest);
  const turnMatch = /Turn: (\d+)/.exec(rest);
  return {
    agentIds: agents,
    messageCount: msgMatch ? parseInt(msgMatch[1]) : 0,
    turnCount: turnMatch ? parseInt(turnMatch[1]) : 0,
  };
}

/**
 * Parse: "Completed. Agents: 1, Actions: 3, hadContent: true, turnCount: 1"
 */
function parseCompletedLine(msg) {
  const m = /Completed\. Agents: (\d+), Actions: (\d+), hadContent: (true|false), turnCount: (\d+)/.exec(msg);
  if (!m) return null;
  return {
    agentCount: parseInt(m[1]),
    totalActions: parseInt(m[2]),
    hadContent: m[3] === 'true',
    turnCount: parseInt(m[4]),
  };
}

/**
 * Extract model ID from thinking-adapter log lines:
 * "[thinking-adapter] Model gemini-3-flash-preview cannot fully disable thinking..."
 */
function extractModel(msg) {
  const m = /Model (\S+) cannot/.exec(msg);
  return m ? m[1] : null;
}

// ── Block → TraceRecord conversion ────────────────────────────────────────────

function blockToRecord(block) {
  // ── Accumulated state ──────────────────────────────────────────────────────
  let model = 'unknown';
  let agentIds = [];
  let turnCount = 0;
  let sawLlmDecision = false;   // true if director called the LLM
  let isFastPath = false;        // true if trigger-agent fast-path was used
  let selectedAgentId = null;
  let directorOutcome = 'end';   // 'dispatch' | 'end' | 'cue_user' | 'turn_limit'
  let agentDispatchTimestamp = null;
  let turnLimitTimestamp = null;
  let completionData = null;
  let aborted = false;
  let httpDurationMs = null;

  // ── Scan parsed lines ──────────────────────────────────────────────────────
  for (const p of block.parsed) {
    if (p.kind === 'http') {
      httpDurationMs = p.durationMs;
      continue;
    }

    const { tag, message, timestamp } = p;

    // Model (from LLM thinking-adapter lines inside this request)
    if (tag === 'LLM' && model === 'unknown') {
      const m = extractModel(message);
      if (m) model = m;
    }

    // Context
    if (tag === 'Chat API' && message.startsWith('Agents:')) {
      const info = parseAgentsLine(message);
      if (info) {
        agentIds = info.agentIds;
        turnCount = info.turnCount;
      }
    }

    // Director decisions (tag = 'DirectorGraph', message has '[Director] ...' prefix)
    if (tag === 'DirectorGraph') {
      // LLM was called: director logged "Raw decision: ..."
      if (message.includes('Raw decision:')) {
        sawLlmDecision = true;
      }

      // Code fast-path: first turn trigger agent
      if (message.includes('First turn: dispatching trigger agent')) {
        const m = /dispatching trigger agent "([^"]+)"/.exec(message);
        if (m) {
          selectedAgentId = m[1];
          directorOutcome = 'dispatch';
          isFastPath = true;
          agentDispatchTimestamp = timestamp;
        }
      }

      // LLM dispatch
      if (message.includes('Decision: dispatch agent')) {
        const m = /Decision: dispatch agent "([^"]+)"/.exec(message);
        if (m) {
          selectedAgentId = m[1];
          directorOutcome = 'dispatch';
          agentDispatchTimestamp = timestamp;
        }
      }

      // Cue user
      if (message.includes('cue USER to speak')) {
        directorOutcome = 'cue_user';
      }

      // Turn limit (fires after agent generation in the director loop)
      if (message.includes('Turn limit reached')) {
        if (directorOutcome !== 'dispatch' && directorOutcome !== 'cue_user') {
          directorOutcome = 'turn_limit';
        }
        turnLimitTimestamp = timestamp;
      }
    }

    // Completion summary
    if (tag === 'StatelessGenerate' && message.includes('Completed.')) {
      completionData = parseCompletedLine(message);
    }

    // Abort markers
    if (
      tag === 'Chat API' &&
      (message === 'Request was aborted' || message === 'Request aborted during streaming')
    ) {
      aborted = true;
    }
  }

  // ── Derive strategy ────────────────────────────────────────────────────────
  let strategy;
  if (sawLlmDecision) {
    strategy = 'llm';
  } else if (isFastPath) {
    strategy = 'code_fast_path';
  } else if (agentIds.length <= 1 && directorOutcome === 'dispatch') {
    strategy = 'code_single_agent';
  } else {
    strategy = 'turn_limit';
  }

  // ── Derive outcome ─────────────────────────────────────────────────────────
  let outcome;
  if (aborted) {
    outcome = 'aborted';
  } else if (directorOutcome === 'cue_user') {
    outcome = 'cue_user';
  } else if (directorOutcome === 'dispatch' && (completionData?.agentCount ?? 0) > 0) {
    outcome = 'agent_dispatched';
  } else if (directorOutcome === 'turn_limit') {
    outcome = 'turn_limit';
  } else if (directorOutcome === 'dispatch') {
    // dispatch logged but Completed shows 0 agents — treat as dispatched anyway
    outcome = 'agent_dispatched';
  } else {
    outcome = 'turn_limit';
  }

  // ── Build agentTurn stub ───────────────────────────────────────────────────
  let agentTurn;
  if (selectedAgentId && (outcome === 'agent_dispatched' || outcome === 'aborted')) {
    const startedAt = agentDispatchTimestamp ?? block.startTimestamp;
    // Agent generation ends roughly at turn-limit log or completion log
    const endedAt = turnLimitTimestamp ?? block.startTimestamp;
    agentTurn = {
      agentId: selectedAgentId,
      // Agent name is not in logs; use ID as placeholder
      agentName: selectedAgentId,
      messageId: `log-${block.startTimestamp}-${selectedAgentId}`,
      startedAt,
      completedAt: endedAt,
      durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
      // Text content and individual actions are not present in logs
      textContent: '',
      textLength: 0,
      actions: [],
      actionCount: completionData?.totalActions ?? 0,
    };
  }

  // ── Timestamps & duration ──────────────────────────────────────────────────
  const requestedAt = block.startTimestamp;
  const completedAt = httpDurationMs != null
    ? new Date(new Date(requestedAt).getTime() + httpDurationMs).toISOString()
    : requestedAt;
  const durationMs = httpDurationMs ?? 0;

  // ── Assemble record ────────────────────────────────────────────────────────
  const record = {
    schemaVersion: SCHEMA_VERSION,
    requestId: randomUUID(),
    recordedAt: new Date().toISOString(),
    requestedAt,
    completedAt,
    durationMs,
    model,
    context: {
      turnCount,
      availableAgentIds: agentIds,
    },
    directorDecision: {
      strategy,
      ...(selectedAgentId ? { selectedAgentId } : {}),
      outcome: directorOutcome,
    },
    ...(agentTurn ? { agentTurn } : {}),
    outcome,
    // Provenance marker: signals to owl-trace-annotator that this record
    // has reduced fidelity (no text content, no per-action detail).
    _fromLogs: true,
  };

  return record;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);

  if (!inputPath || inputPath === '--help' || inputPath === '-h') {
    console.error(
      'Usage: node scripts/convert-logs-to-traces.mjs <input.log|-> [output.jsonl]',
    );
    process.exit(inputPath ? 0 : 1);
  }

  // Read
  const stream = inputPath === '-' ? process.stdin : createReadStream(inputPath, 'utf8');
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) lines.push(line);

  // Convert
  const blocks = groupIntoBlocks(lines);
  const records = blocks.map(blockToRecord);

  // Write
  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n';

  if (outputPath) {
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(outputPath, 'utf8');
      ws.on('finish', resolve);
      ws.on('error', reject);
      ws.end(jsonl);
    });
    console.error(`✓ Converted ${records.length} /api/chat requests → ${outputPath}`);
  } else {
    process.stdout.write(jsonl);
    console.error(`✓ Converted ${records.length} /api/chat requests`);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
