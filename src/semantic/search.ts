/**
 * The fast-context search loop.
 *
 * Ported from dsh-assistant-optimization `lib/fast-context/core.js`
 * (itself from fast-context-mcp `src/core.mjs`, MIT). Changes:
 *  - one brain (./brain.ts), so the A/B selection and the local-model fallback
 *    are gone — a missing key means "no tool", decided at startup;
 *  - output paths are workspace-relative, matching what `editor`
 *    takes, and the search scope is pinned to the session workspace by the
 *    executor rather than by a caller-supplied project_path;
 *  - every turn re-checks the AbortSignal: the MCP client disconnecting must
 *    stop the loop, or a 60s-timeout client retrying would burn the operator's
 *    quota twice for one question.
 *
 * Mechanism, in one paragraph — because "semantic" here is misleading: nothing
 * is embedded and nothing is indexed. The repo map seeds a prompt; the model
 * asks for local commands (rg/readfile/tree/ls/glob); we run them in the
 * workspace and feed the output back; after maxTurns a forced final round
 * returns <file path><range> XML. The "semantics" are the model's understanding
 * of the query plus that iterate-until-grounded loop.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveInWorkspace } from '../util/fspaths.js';

import { ToolExecutor } from './executor.js';
import { FINAL_FORCE_ANSWER, getRepoMap, parseAnswer, type AnswerFile } from './shared.js';
import { buildSearchPrompt } from './prompt.js';
import { buildCacheKey, computeMtimeHash, getCachedResult, setCachedResult } from './cache.js';
import { salvageSearchEvidence } from './repair.js';
import { BRAIN_MODEL, FastContextError, classifyError, windsurfBrain } from './brain.js';
import { formatResult } from './content.js';

export interface SearchOptions {
  query: string;
  workspaceRoot: string;
  apiKey: string;
  maxTurns?: number;
  maxCommands?: number;
  maxResults?: number;
  treeDepth?: number;
  timeoutMs?: number;
  excludePaths?: string[];
  includeContent?: boolean;
  /**
   * Subdirectory of the workspace to search, workspace-relative. When set, the
   * repo map, the command guard and the model's `/codebase` all become that
   * directory — a strictly smaller blast radius than the workspace, which is
   * the point (a 100k-file monorepo needs it). Reported paths stay
   * workspace-relative so they remain valid `editor` arguments.
   */
  subPath?: string;
  /** danger-full-access: `subPath` may point outside the workspace (results use absolute paths there). */
  allowOutside?: boolean;
  signal?: AbortSignal | null;
  onProgress?: (line: string) => void;
}

export interface SearchMeta {
  treeDepth: number;
  treeSizeKB: number;
  fellBack: boolean;
  brain?: string;
  cacheHit?: boolean;
  salvaged?: boolean;
  contextTrimmed?: boolean;
  errorCode?: string;
  fallback?: string;
}

export interface SearchResult {
  files: AnswerFile[];
  rg_patterns?: string[];
  error?: string;
  raw_response?: string;
  _meta: SearchMeta;
}

/** Keep the conversation under the payload limit: head, bridge note, last two. */
function trimMessages(messages: { role: number; content: string }[]): boolean {
  if (messages.length <= 4) return false;
  const head = messages.slice(0, 2);
  const tail = messages.slice(-2);
  messages.length = 0;
  messages.push(
    ...head,
    { role: 1, content: '[Prior search rounds omitted to reduce payload. Provide your best answer based on available context.]' },
    ...tail,
  );
  return true;
}

/** A failure diagnosed before any work happened: no tree facts to report. */
function baselessMeta(treeDepth: number): SearchMeta {
  return { treeDepth, treeSizeKB: 0, fellBack: false };
}

/**
 * Re-express found paths relative to the session workspace. When `root`
 * is a subdirectory the agent would otherwise get paths it cannot feed
 * back to `editor`.
 */
function relOrAbs(base: string, full: string): string {
  const rel = path.relative(base, full);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? full.split(path.sep).join('/') : rel.split(path.sep).join('/');
}

function relativise<T extends { files: AnswerFile[] }>(result: T, workspaceRoot: string): T {
  const base = path.resolve(workspaceRoot);
  return {
    ...result,
    files: result.files.map((file) => ({
      ...file,
      path: relOrAbs(base, file.full_path),
    })),
  };
}

/**
 * Run one semantic search. Returns a structured result; failure is data
 * (`error` + `_meta.errorCode`) rather than an exception, because the caller
 * must hand the agent a diagnosis it can act on (lower tree_depth, add
 * exclude_paths, narrow path).
 */
export async function search(opts: SearchOptions): Promise<SearchResult> {
  const {
    query,
    workspaceRoot,
    apiKey,
    maxTurns = 3,
    maxCommands = 8,
    maxResults = 10,
    treeDepth = 3,
    timeoutMs = 30_000,
    excludePaths = [],
    signal = null,
    onProgress = null,
    subPath,
    allowOutside = false,
  } = opts;
  const log = (line: string): void => onProgress?.(line);

  let root: string;
  try {
    root = !subPath ? workspaceRoot
      : allowOutside ? path.resolve(workspaceRoot, subPath)
        : resolveInWorkspace(workspaceRoot, subPath);
  } catch (e) {
    return { files: [], error: `path is outside the workspace: ${e instanceof Error ? e.message : String(e)}`, _meta: baselessMeta(treeDepth) };
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { files: [], error: `path is not a directory: ${subPath ?? '/'}`, _meta: baselessMeta(treeDepth) };
  }

  let state;
  try {
    state = await windsurfBrain.prepare({ apiKey }, signal);
  } catch (e) {
    const err = e instanceof FastContextError ? e : classifyError(e);
    return {
      files: [],
      error: `${err.code}: ${err.message}`,
      _meta: { treeDepth, treeSizeKB: 0, fellBack: false, errorCode: err.code },
    };
  }

  // Cache lookup happens after auth on purpose: the key is what makes the
  // fingerprint trustworthy (same repo + same model => same answer window).
  const mtimeHash = computeMtimeHash(root, excludePaths);
  const cacheKey = buildCacheKey({ query, model: BRAIN_MODEL, maxTurns, maxResults, treeDepth, mtimeHash, excludePaths });
  const cached = getCachedResult<SearchResult>(cacheKey);
  if (cached) {
    log('cache hit');
    return { ...cached, _meta: { ...cached._meta, cacheHit: true } };
  }

  const systemPrompt = buildSearchPrompt(maxTurns, maxCommands, maxResults);
  const executor = new ToolExecutor(root, { signal });
  const { tree: repoMap, depth: actualDepth, sizeBytes: treeSizeBytes, fellBack } = getRepoMap(root, treeDepth, excludePaths);
  log(`repo map: tree -L ${actualDepth} (${(treeSizeBytes / 1024).toFixed(1)}KB)${fellBack ? ` [fell back from L=${treeDepth}]` : ''}`);
  const baseMeta: SearchMeta = {
    treeDepth: actualDepth,
    treeSizeKB: Number((treeSizeBytes / 1024).toFixed(1)),
    fellBack,
    brain: windsurfBrain.kind,
  };

  const messages: { role: number; content: string; tool_call_id?: string; tool_name?: string; tool_args_json?: string; ref_call_id?: string }[] = [
    { role: 5, content: systemPrompt },
    {
      role: 1,
      content: `Problem Statement: ${query}\n\nRepo Map (tree -L ${actualDepth} /codebase):\n\`\`\`text\n${repoMap}\n\`\`\``,
    },
  ];

  // maxTurns search rounds + 1 round that only answers.
  const totalApiCalls = maxTurns + 1;
  let compensatedTurns = 0;
  const MAX_COMPENSATIONS = 2;
  let forceAnswerInjected = false;

  for (let turn = 0; turn < totalApiCalls + compensatedTurns; turn += 1) {
    if (signal?.aborted) {
      return { files: [], error: 'aborted', _meta: baseMeta };
    }
    log(`turn ${turn + 1}/${totalApiCalls}`);

    let text = '';
    let toolCalls: { name: string; args: Record<string, unknown> }[] = [];
    try {
      const out = await windsurfBrain.stream(state, messages, { maxCommands, timeoutMs, signal });
      text = out.text;
      toolCalls = out.toolCalls;
    } catch (e) {
      const err = e instanceof FastContextError ? e : classifyError(e);
      if ((err.code === 'PAYLOAD_TOO_LARGE' || err.code === 'TIMEOUT') && messages.length > 4) {
        log(`${err.code} on turn ${turn + 1}: trimming context and retrying...`);
        trimMessages(messages);
        try {
          const out = await windsurfBrain.stream(state, messages, { maxCommands, timeoutMs, signal });
          text = out.text;
          toolCalls = out.toolCalls;
        } catch (retryErr) {
          const retry = retryErr instanceof FastContextError ? retryErr : classifyError(retryErr);
          return { files: [], error: `${retry.code}: ${retry.message} (retry after context trim also failed)`, _meta: { ...baseMeta, errorCode: retry.code, contextTrimmed: true } };
        }
      } else {
        return { files: [], error: `${err.code}: ${err.message}`, _meta: { ...baseMeta, errorCode: err.code } };
      }
    }

    const answerCall = toolCalls.find((c) => c?.name === 'answer');
    const execCall = toolCalls.find((c) => c?.name === 'restricted_exec');
    const toolInfo: [string, Record<string, unknown>] | null = answerCall
      ? ['answer', answerCall.args ?? {}]
      : execCall
        ? ['restricted_exec', execCall.args ?? {}]
        : null;

    if (toolInfo === null) {
      // No tool call: either an explicit upstream error, or a model that
      // answered in prose. Salvage file paths/patterns from the text before
      // giving up — a half-right answer beats an error.
      if (text.startsWith('[Error]')) return { files: [], error: text, _meta: baseMeta };
      const salvaged = relativise(salvageSearchEvidence(text, root), workspaceRoot);
      if (salvaged.files.length || salvaged.rg_patterns.length) {
        return { ...salvaged, raw_response: text, _meta: { ...baseMeta, salvaged: true } };
      }
      return { files: [], raw_response: text, _meta: baseMeta };
    }

    const [toolName, toolArgs] = toolInfo;

    if (toolName === 'answer') {
      log('received final answer');
      const parsed = relativise(parseAnswer(String(toolArgs.answer ?? ''), root), workspaceRoot);
      const result: SearchResult = {
        files: parsed.files,
        rg_patterns: [...new Set(executor.collectedRgPatterns)],
        _meta: { ...baseMeta, cacheHit: false },
      };
      // Empty results are not cached: the next ask should be allowed to search.
      if (result.files.length > 0) setCachedResult(cacheKey, result);
      return result;
    }

    const callId = randomUUID();
    const argsJson = JSON.stringify(toolArgs);
    const cmds = Object.keys(toolArgs).filter((k) => k.startsWith('command'));
    log(`executing ${cmds.length} local command(s)`);
    const results = await executor.execToolCall(toolArgs);

    // An all-invalid command object cost the agent a turn it did not really
    // use; extend the budget instead of ending the search on a parse glitch.
    const validCommands = cmds.filter((k) => {
      const cmd = toolArgs[k];
      return cmd && typeof cmd === 'object' && typeof (cmd as Record<string, unknown>).type === 'string';
    });
    if (validCommands.length === 0 && compensatedTurns < MAX_COMPENSATIONS) {
      compensatedTurns += 1;
      log(`turn compensation: no valid commands, extending search (${compensatedTurns}/${MAX_COMPENSATIONS})`);
    }

    messages.push({ role: 2, content: text || '', tool_call_id: callId, tool_name: 'restricted_exec', tool_args_json: argsJson });
    messages.push({ role: 4, content: results, ref_call_id: callId });

    const effectiveTurn = turn - compensatedTurns;
    if (effectiveTurn >= maxTurns - 1 && !forceAnswerInjected) {
      messages.push({ role: 1, content: FINAL_FORCE_ANSWER });
      forceAnswerInjected = true;
      log('injected force-answer prompt');
    }
  }

  const conversation = messages.flatMap((m) => [m.content, m.tool_args_json]).filter(Boolean).join('\n');
  const salvaged = relativise(salvageSearchEvidence(conversation, root), workspaceRoot);
  if (salvaged.files.length || salvaged.rg_patterns.length) {
    return { ...salvaged, _meta: { ...baseMeta, salvaged: true } };
  }
  return {
    files: [],
    error: 'max turns reached without an answer',
    rg_patterns: [...new Set(executor.collectedRgPatterns)],
    _meta: baseMeta,
  };
}

/**
 * Search and render the agent-facing report. Everything the failure modes need
 * to be actionable (which depth was actually used, what to lower, whether the
 * tree fell back) goes into the error text: an agent that only sees "Error:
 * TIMEOUT" cannot recover, and will retry the expensive call unchanged.
 */
export interface SearchReport {
  report: string;
  meta: SearchMeta;
  fileCount: number;
  files: AnswerFile[];
  /** 内容预算截断的文件数（0 = 全部完整嵌入）。 */
  truncatedFiles: number;
}

export async function searchWithContext(opts: SearchOptions): Promise<SearchReport> {
  const result = await search(opts);

  if (result.error) {
    const meta = result._meta;
    let out = `Error: ${result.error}`;
    out += `\n\n[diagnostic] error_type=${meta.errorCode ?? 'unknown'}, tree_depth_used=${meta.treeDepth}, tree_size=${meta.treeSizeKB}KB`;
    if (meta.fellBack) out += ' (tree auto fell back from the requested depth)';
    if (meta.contextTrimmed) out += ', context_trimmed=true';
    out += `\n[config] max_turns=${opts.maxTurns ?? 3}, max_results=${opts.maxResults ?? 10}, max_commands=${opts.maxCommands ?? 8}, timeout_ms=${opts.timeoutMs ?? 30_000}`;
    if (opts.excludePaths?.length) out += `, exclude_paths=[${opts.excludePaths.join(', ')}]`;
    if (meta.errorCode === 'PAYLOAD_TOO_LARGE' || meta.errorCode === 'TIMEOUT') {
      out += '\n[hint] Narrow the scope: pass a subdirectory as `path`, lower tree_depth, lower max_turns, or add exclude_paths.';
    } else if (meta.errorCode === 'AUTH_ERROR') {
      out += '\n[hint] The search credential was rejected. Ask the operator to refresh it (run ' + '`' + 'blackhole semantic <KEY>' + '`' + ' on this machine).';
    } else if (meta.errorCode === 'RATE_LIMITED') {
      out += '\n[hint] Rate limited by the search service. Wait a moment, or fall back to grep via pwsh.';
    } else {
      out += '\n[hint] Fall back to grep via pwsh for this one; if it repeats, narrow path or tree_depth.';
    }
    return { report: out, meta, fileCount: 0, files: [], truncatedFiles: 0 };
  }

  const files = result.files ?? [];
  if (files.length === 0) {
    const raw = result.raw_response ?? '';
    return {
      report: raw ? `No relevant files found.\n\nModel response:\n${raw}` : 'No relevant files found.',
      meta: { ...result._meta, salvaged: result._meta.salvaged ?? false },
      fileCount: 0,
      files: [],
      truncatedFiles: 0,
    };
  }
  // A salvaged result is the loop running out of turns, not a verified
  // answer: the files are what the model was READING and the ranges are
  // guesses. The agent acts on `message`, so the caveat must live in the
  // text itself — the structured meta.salvaged flag alone is invisible to it.
  const salvagedNote = result._meta.salvaged
    ? 'NOTE: recovered from an unfinished search (no final answer was returned). These are the files the search was reading and the ranges are approximate — confirm with view before editing.\n\n'
    : '';
  const formatted = formatResult(files, { includeContent: opts.includeContent !== false });
  return {
    report: salvagedNote + formatted.report,
    meta: result._meta,
    fileCount: files.length,
    truncatedFiles: formatted.truncatedFiles,
    files,
  };
}
