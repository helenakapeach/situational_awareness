import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBackendMode } from '../src/backend.ts'

test('API configuration alone never changes the default Supabase backend', () => {
  assert.equal(resolveBackendMode({ search: '', apiBaseUrl: 'https://sandbox-api.example' }), 'supabase')
  assert.equal(resolveBackendMode({ search: '?post=42', apiBaseUrl: 'https://sandbox-api.example' }), 'supabase')
  assert.equal(resolveBackendMode({ search: '?backend=supabase', apiBaseUrl: 'https://sandbox-api.example' }), 'supabase')
})

test('Mongo requires an explicit URL opt-in and an API base URL', () => {
  assert.equal(resolveBackendMode({ search: '?backend=mongo', apiBaseUrl: 'https://sandbox-api.example' }), 'mongo')
  assert.throws(
    () => resolveBackendMode({ search: '?backend=mongo' }),
    /Mongo backend was requested, but no API base URL is configured/,
  )
})

test('the explicit demo switch remains available', () => {
  assert.equal(resolveBackendMode({ search: '?demo=1&backend=mongo' }), 'demo')
})
