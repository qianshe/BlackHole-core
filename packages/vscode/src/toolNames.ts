/** Presentation contract for this independently built extension.
 * Keep in sync with src/tool-routing.ts (enforced by editor-rename tests).
 * Historical recognition never registers or forwards an MCP alias.
 */
export const WORKSPACE_FILE_TOOL = 'editor';
export const LEGACY_WORKSPACE_FILE_TOOL = 'workspace_editor';
export function isWorkspaceFileTool(tool: string): boolean {
  return tool === WORKSPACE_FILE_TOOL || tool === LEGACY_WORKSPACE_FILE_TOOL;
}
export function displayToolName(tool: string): string {
  return isWorkspaceFileTool(tool) ? WORKSPACE_FILE_TOOL : tool;
}
