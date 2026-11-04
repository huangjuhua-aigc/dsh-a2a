import { spawnSync } from 'node:child_process'
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/docker.integration.spec.ts'], {
  stdio: 'inherit', windowsHide: true, env: { ...process.env, A2A_DOCKER_TEST: '1' },
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
