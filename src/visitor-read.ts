import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { workspaceReadTool } from './workspace-read.ts'

/** Both roots are explicit; a visitor can never select another visitor's root. */
export async function visitorReadTool(dataRoot: string, workRoot: string, privatePaths: string[]): Promise<ToolDefinition> {
  const data = await workspaceReadTool(dataRoot, privatePaths)
  const work = await workspaceReadTool(workRoot, [])
  return {
    ...data,
    description: 'Read UTF-8 text or list directories. root="public" (default) reads shared public data; root="workspace" reads only your private workspace. path "." lists that root. Other visitors, host files and conversation logs are unavailable. Maximum file size 2 MiB; limit <= 500.',
    parameters: { ...data.parameters, properties: { ...(data.parameters.properties as Record<string, unknown>), root: { type: 'string', enum: ['public', 'workspace'] } } },
    execute: async (raw, context) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid read request')
      const { root = 'public', ...args } = raw as Record<string, unknown>
      if (root !== 'public' && root !== 'workspace') throw new Error('Unknown data root')
      return await (root === 'public' ? data : work).execute(args, context)
    },
  }
}
