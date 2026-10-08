import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WORKFLOW_NAMES } from '../workspace/workflows.js';
import { HANDOFF_MAX_BYTES } from '../storage/handoffs.js';

// Discovery and pre-dispatch validation share exactly one flat schema.
export const GUIDE_INPUT = z.object({
  sessionId: z.string().min(1).optional().describe('Supplied session credential; selects project instructions and is required for submission. Skill discovery uses the skill tool.'),
  entry: z.enum(['sandbox']).optional().describe('Presentation selector for the initial Sandbox guide only. It does not change authorization, session routing, or tool capabilities.'),
  tool: z.enum(['exec', 'process']).optional(),
  workflow: z.enum(WORKFLOW_NAMES).optional().describe('Explicit user keyword invocation only: plan/计划 = write a plan; execute-plan/执行计划/执行 plan = execute or resume an existing plan; handoff = prepare transfer context; review = assess without fixes. Use the canonical English value. Omit for mentions, quoted or negated text, template-editing requests, or similar intent without a keyword.'),
  content: z.string().min(1).max(HANDOFF_MAX_BYTES).optional().describe('Only workflow=handoff: save plain task context, at most 64 KiB UTF-8. Replaces pending context; omit credentials and connection instructions.'),
}).strict();

/** Install before the first tool registration. Use the public registration seam,
 * not SDK internals: the SDK otherwise serializes Zod issues (including values).
 * Other tool handlers and their errors are delegated unchanged. */
export function guardGuideInput(server: McpServer): void {
  const protocol = server.server;
  const original = protocol.setRequestHandler;
  const register: typeof original = (schema, handler) => {
    if ((schema as unknown as { shape?: { method?: { value?: string } } }).shape?.method?.value !== 'tools/call') return original.call(protocol, schema, handler);
    protocol.setRequestHandler = original;
    const guarded: typeof handler = async (request, extra) => {
      const call = request as unknown as { params: { name?: string; arguments?: unknown } };
      if (call.params.name === 'guide') {
        const parsed = await GUIDE_INPUT.safeParseAsync(call.params.arguments ?? {});
        if (!parsed.success) return {
          isError: true,
          content: [{ type: 'text', text: 'Invalid guide arguments. Use only sessionId, entry, tool, workflow and content with their declared types and limits.' }],
        };
      }
      return handler(request, extra);
    };
    return original.call(protocol, schema, guarded);
  };
  protocol.setRequestHandler = register;
}
