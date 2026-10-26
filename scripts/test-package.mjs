/** Smoke-test the built plugin with only its declared direct runtime packages. */
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-a2a-package-'))
try {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await cp(join(root, 'lib'), join(temporary, 'lib'), { recursive: true })
  await writeFile(join(temporary, 'package.json'), JSON.stringify(manifest))
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    const target = join(temporary, 'node_modules', name)
    await mkdir(dirname(target), { recursive: true })
    await symlink(await realpath(join(root, 'node_modules', name)), target, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./lib/index.js"); console.log("Declared-runtime package import passed")'], { cwd: temporary, encoding: 'utf8' })
  process.stdout.write(run.stdout ?? '')
  process.stderr.write(run.stderr ?? '')
  if (run.error) throw run.error
  if (run.status !== 0) process.exitCode = 1
} finally {
  if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep)) throw new Error('unsafe temporary path')
  await rm(temporary, { recursive: true, force: true })
}
