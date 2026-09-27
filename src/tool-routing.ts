/** Canonical MCP identity. The historical name is read-only compatibility, never an alias. */
export const WORKSPACE_FILE_TOOL = 'editor';
export const LEGACY_WORKSPACE_FILE_TOOL = 'workspace_editor';
export const WORKSPACE_FILE_TOOL_HISTORY = [WORKSPACE_FILE_TOOL, LEGACY_WORKSPACE_FILE_TOOL] as const;

export function isWorkspaceFileTool(tool: string): boolean {
  return tool === WORKSPACE_FILE_TOOL || tool === LEGACY_WORKSPACE_FILE_TOOL;
}

/** Normalize presentation only; never rewrite stored audit identities. */
export function displayToolName(tool: string): string {
  return isWorkspaceFileTool(tool) ? WORKSPACE_FILE_TOOL : tool;
}

/**
 * The routing line agents see. Two pieces must reflect reality or the agent
 * hunts for tools that do not exist (both were real drift):
 *  - finite commands always route to the single stable `exec` tool,
 *  - the context_search clause is only written when the tool is registered.
 */
export function toolRouting(_execTool: string | null | undefined, semantic: boolean, processes = false): string {
  const commandTool = 'commands/tests/build/Git → exec.';
  return [
    `Tool routing: files → ${WORKSPACE_FILE_TOOL};`,
    semantic ? 'unknown code location → context_search;' : '',
    commandTool,
    processes ? 'Explicit background dev servers/watch tasks → process start.' : '',
    'Do not use command execution for ordinary file inspection or editing.',
  ]
    .filter(Boolean)
    .join(' ');
}
