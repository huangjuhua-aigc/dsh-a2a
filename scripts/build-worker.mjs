import { build } from 'esbuild'
import { copyFile } from 'node:fs/promises'
await build({ entryPoints: ['src/visitor-worker.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'lib/visitor-worker.mjs' })
await copyFile('src/visitor-worker.py', 'lib/visitor-worker.py')
