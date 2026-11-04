import { spawnSync } from 'node:child_process'
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/microsandbox.integration.spec.ts'], {
  stdio: 'inherit', windowsHide: true, env: { ...process.env, A2A_MICROSANDBOX_TEST: '1' },
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
