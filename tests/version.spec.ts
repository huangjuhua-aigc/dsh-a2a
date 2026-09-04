/**
 * The card version and the package manifest are one fact stored in two files.
 *
 * They drifted once already: the manifest went to 0.1.1 while the card kept
 * serving 0.1.0, and nothing failed. This test is the reason that cannot
 * happen quietly again.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SERVER_VERSION } from '../src/version.ts'

describe('server version', () => {
  it('matches the version npm will publish', () => {
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }
    expect(SERVER_VERSION).toBe(manifest.version)
  })
})
