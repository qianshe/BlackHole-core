import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const MAX_OUTPUT_CHARS = 16000;

function clip(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n\n[... output truncated at ${MAX_OUTPUT_CHARS} chars ...]`;
}

function toLines(text) {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** cat -n style, one-based line numbers, tabs preserved. */
function numberLines(content, startLine = 1) {
  return toLines(content).map((l, i) => `${String(startLine + i).padStart(6, ' ')}\t${l}`).join('\n');
}

/**
 * editor over absolute paths, guarded to a Workspace.
 * Commands: view | create | str_replace | insert | delete. Mirrors DSH minimal
 * semantics; `delete` is our bounded single-file extension (workspace-only).
 */
export class Editor {
  constructor(workspace) {
    this.ws = workspace;
  }

  async view(rawPath, viewRange) {
    const abs = await this.ws.guard(rawPath);
    if (!existsSync(abs)) {
      return this._err(`FS_NOT_FOUND: ${abs} does not exist`, abs);
    }
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      if (Array.isArray(viewRange)) {
        return this._err('The `view_range` parameter is not allowed when `path` points to a directory.', abs);
      }
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const listing = entries
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`)
        .sort();
      return ok(`Directory: ${abs}\n${listing.join('\n') || '(empty)'}`, abs);
    }
    const content = await fs.readFile(abs, 'utf8');
    if (Array.isArray(viewRange) && viewRange.length === 2) {
      const [start, end] = viewRange;
      const allLines = toLines(content);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return this._err('Invalid `view_range`. It should be a list of two integers.', abs);
      }
      if (start < 1 || start > allLines.length) {
        return this._err(`Invalid \`view_range\`: start \`${start}\` should be within [1, ${allLines.length}].`, abs);
      }
      if (end !== -1 && end < start) {
        return this._err(`Invalid \`view_range\`: end \`${end}\` should be >= start \`${start}\` (or -1 for EOF).`, abs);
      }
      const stopLine = end === -1 ? allLines.length : Math.min(end, allLines.length);
      const selected = allLines.slice(start - 1, stopLine).join('\n');
      return ok(`${abs} with view_range=[${start}, ${stopLine}]\n${clip(numberLines(selected, start))}`, abs);
    }
    return ok(`${abs}\n${clip(numberLines(content))}`, abs);
  }

  async create(rawPath, content) {
    const abs = await this.ws.guard(rawPath);
    if (existsSync(abs)) {
      return this._err(`File already exists at: ${abs}. Cannot overwrite files using command \`create\`.`, abs);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return ok(`Created file at ${abs} (${content.length} chars).`, abs, { locations: [abs] });
  }

  async strReplace(rawPath, oldText, newText) {
    const abs = await this.ws.guard(rawPath);
    if (!existsSync(abs)) return this._err(`FS_NOT_FOUND: ${abs} does not exist`, abs);
    const original = await fs.readFile(abs, 'utf8');
    if (oldText === newText) return this._err('old_text and new_text must differ', abs);
    const count = original.split(oldText).length - 1;
    if (count === 0) return this._err(`old_text not found in ${abs}`, abs);
    if (count > 1) return this._err(`old_text must be unique; found ${count} occurrences in ${abs}`, abs);
    const updated = original.replace(oldText, newText);
    await fs.writeFile(abs, updated, 'utf8');
    return ok(`The file ${abs} has been edited. Replaced 1 occurrence.`, abs, { locations: [abs] });
  }

  async insert(rawPath, line, content) {
    const abs = await this.ws.guard(rawPath);
    if (!existsSync(abs)) return this._err(`FS_NOT_FOUND: ${abs} does not exist`, abs);
    const original = await fs.readFile(abs, 'utf8');
    const lines = toLines(original);
    if (!Number.isInteger(line) || line < 0 || line > lines.length) {
      return this._err(`Invalid \`line\` parameter: ${line}. Use 0 for the beginning or a one-based existing line in [1, ${lines.length}].`, abs);
    }
    const inserted = toLines(content);
    const updatedLines = [...lines.slice(0, line), ...inserted, ...lines.slice(line)];
    const preserveTerminalNewline = /(?:\r?\n)$/.test(original) || (line === lines.length && /(?:\r?\n)$/.test(content));
    const updated = updatedLines.join('\n') + (preserveTerminalNewline && updatedLines.length > 0 ? '\n' : '');
    await fs.writeFile(abs, updated, 'utf8');
    return ok(`Inserted content after line ${line} in ${abs}.`, abs, { locations: [abs] });
  }

  /**
   * Delete ONE regular file inside the workspace. Structurally bounded
   * (workspace guard + file-only), so it rides the same policy gate as other
   * editor writes — unlike shell `rm`/`Remove-Item`, which stay on the
   * destructive-review path because they can reach anywhere.
   */
  async delete(rawPath) {
    const abs = await this.ws.guard(rawPath);
    let st;
    try { st = await fs.stat(abs); } catch { return this._err(`FS_NOT_FOUND: ${abs} does not exist`, abs); }
    if (!st.isFile()) return this._err(`Refusing to delete: not a regular file (directories are out of scope): ${abs}`, abs);
    await fs.unlink(abs);
    return ok(`Deleted ${abs}`, abs, { locations: [abs] });
  }

  _err(msg, abs) {
    const text = `Error: ${msg}`;
    return { content: [{ type: 'text', text }], isError: true, structuredContent: { result: text }, locations: abs ? [abs] : [] };
  }
}

function ok(text, abs, extra = {}) {
  return { content: [{ type: 'text', text }], isError: false, structuredContent: { result: text }, locations: extra.locations || (abs ? [abs] : []) };
}
