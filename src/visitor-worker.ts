// Bundled into one dependency-free executable; receives no host credentials.
import { visitorReadTool } from './visitor-read.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

let input = ''
for await (const bytes of process.stdin) {
  input += String(bytes)
  if (Buffer.byteLength(input) > 8192) throw new Error('Read request too large')
}
try {
  const tool = await visitorReadTool('/source', '/work', [])
  const result = await tool.execute(JSON.parse(input), { signal: new AbortController().signal } as ToolRunContext)
  process.stdout.write(JSON.stringify({ result }))
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Read failed' }))
  process.exitCode = 1
}
