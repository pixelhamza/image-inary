// This module never receives vault passphrases or unwrapped encryption keys.
export async function checkHealth(signal?: AbortSignal): Promise<void> {
  const response = await fetch('/healthz', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('API is unavailable')

  const body: unknown = await response.json()
  if (
    typeof body !== 'object' || body === null ||
    !('status' in body) || body.status !== 'ok'
  ) {
    throw new Error('Unexpected health response')
  }
}
