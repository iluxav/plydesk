import type { SavedConn } from '../fw/types'

export type ConnectionForm = {
  host: string; user: string; authentication: 'key' | 'password'
  identityFile: string; password: string; passphrase: string
}
export function connectionForm(saved?: SavedConn): ConnectionForm {
  return { host: saved?.host || '', user: saved?.user || '', authentication: saved?.authentication || 'key',
    identityFile: saved?.identityFile || '', password: '', passphrase: '' }
}
export function connectionCredentials(form: ConnectionForm) {
  return form.authentication === 'password' ? { password: form.password || undefined, identityFile: undefined, passphrase: undefined }
    : { password: undefined, identityFile: form.identityFile.trim() || undefined, passphrase: form.identityFile.trim() ? form.passphrase || undefined : undefined }
}
