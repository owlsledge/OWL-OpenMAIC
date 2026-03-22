/**
 * TraceExporter — writes TraceRecords to disk as newline-delimited JSON (JSONL).
 *
 * Each line in the output file is one serialised TraceRecord.
 * Files are rotated daily: traces-YYYY-MM-DD.jsonl
 *
 * Configuration (environment variables):
 *   TRACE_ENABLED     Set to "true" to enable tracing (disabled by default)
 *   TRACE_OUTPUT_DIR  Directory for JSONL files (default: "./traces")
 *
 * The exporter never throws — write failures are logged but do not crash the
 * request that produced the trace.
 */

import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { TraceRecord } from './schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('TraceExporter');

export function isTraceEnabled(): boolean {
  return process.env.TRACE_ENABLED === 'true';
}

function outputDir(): string {
  return process.env.TRACE_OUTPUT_DIR ?? './traces';
}

/** Returns the JSONL filename for today: traces-YYYY-MM-DD.jsonl */
function dailyFilename(): string {
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `traces-${dateStr}.jsonl`;
}

/**
 * Append a TraceRecord to today's JSONL file.
 *
 * No-op when TRACE_ENABLED !== 'true'.
 * Creates the output directory if it does not exist.
 * Never throws — logs errors instead of surfacing them to callers.
 */
export async function exportTrace(record: TraceRecord): Promise<void> {
  if (!isTraceEnabled()) return;

  try {
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, dailyFilename());
    await appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
    log.debug(`Trace ${record.requestId} written to ${filePath}`);
  } catch (err) {
    log.error('Failed to write trace record:', err);
  }
}
