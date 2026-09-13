import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectionForm, connectionCredentials } from '../src/desktop/connectionModel.ts'

test('saved machines restore their authentication choice and key path without restoring secrets', () => {
  const saved = { user: 'dev', host: 'server', authentication: 'key', identityFile: '~/.ssh/work key', password: 'must not restore', passphrase: 'must not restore' }
  const form = connectionForm(saved)
  assert.equal(form.identityFile, '~/.ssh/work key')
  assert.equal(form.password, '')
  assert.equal(form.passphrase, '')
  assert.equal(connectionForm({ user: 'dev', host: 'old-machine' }).authentication, 'key')
  assert.equal(connectionForm({ ...saved, authentication: 'password' }).authentication, 'password')
})

test('only credentials for the selected authentication method reach SSH', () => {
  const form = { ...connectionForm(), password: 'password fixture', identityFile: ' ~/.ssh/work key ', passphrase: 'key fixture' }
  assert.deepEqual(connectionCredentials(form), { password: undefined, identityFile: '~/.ssh/work key', passphrase: 'key fixture' })
  assert.deepEqual(connectionCredentials({ ...form, identityFile: '' }), { password: undefined, identityFile: undefined, passphrase: undefined })
  assert.deepEqual(connectionCredentials({ ...form, authentication: 'password' }), { password: 'password fixture', identityFile: undefined, passphrase: undefined })
})
