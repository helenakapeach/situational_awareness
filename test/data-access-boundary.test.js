import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : [path]
  }))
  return files.flat()
}

// This is a regression guard for application-owned source, not a security sandbox.
// Only backend.js can import the Supabase data SDK; other modules receive Auth only.
test('Supabase data access stays in backend.js', async () => {
  for (const path of await sourceFiles(sourceRoot)) {
    const name = relative(sourceRoot, path)
    if (name === 'backend.js') continue
    const source = await readFile(path, 'utf8')
    assert.doesNotMatch(source, /@supabase\//, `${name}: Supabase SDK imports belong in backend.js`)
    assert.doesNotMatch(source, /\/rest\/v1\b/, `${name}: Supabase REST calls belong in backend.js`)
    assert.doesNotMatch(source, /\.\s*rpc\s*\(/, `${name}: Supabase RPC calls belong in backend.js`)
    assert.doesNotMatch(source, /\.\s*storage\s*(?:\.|\[)/, `${name}: Supabase Storage access belongs in backend.js`)
  }
})
