import { assertID, decryptEnvelope, encryptEnvelope, ENVELOPE_OVERHEAD, fromBase64, toBase64, webCrypto } from './envelope'

export const KDF_ITERATIONS = 600_000
const verifierText = 'Imageinary vault verifier v1'

export type VaultConfig = {
  version: 1
  id: string
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string }
  verifier: string
}

export function validateVaultConfig(value: unknown): asserts value is VaultConfig {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid vault configuration.')
  const config = value as Partial<VaultConfig>
  const kdf = config.kdf
  if (
    config.version !== 1 || typeof config.id !== 'string' ||
    typeof kdf !== 'object' || kdf === null || kdf.name !== 'PBKDF2' ||
    kdf.hash !== 'SHA-256' || kdf.iterations !== KDF_ITERATIONS ||
    typeof kdf.salt !== 'string' || kdf.salt.length !== 24 ||
    typeof config.verifier !== 'string' || config.verifier.length > 256
  ) throw new Error('Invalid or unsupported vault configuration.')
  assertID(config.id)
  if (fromBase64(kdf.salt).length !== 16 || fromBase64(config.verifier).length !== verifierText.length + ENVELOPE_OVERHEAD) {
    throw new Error('Invalid vault salt or verifier.')
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const crypto = webCrypto()
  const encoded = new TextEncoder().encode(passphrase)
  try {
    const material = await crypto.subtle.importKey('raw', encoded, 'PBKDF2', false, ['deriveKey'])
    return await crypto.subtle.deriveKey({
      name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: new Uint8Array(salt),
    }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  } finally {
    encoded.fill(0)
  }
}

export async function createVault(passphrase: string): Promise<{ config: VaultConfig; key: CryptoKey }> {
  if (passphrase.length < 12) throw new Error('Use a vault passphrase of at least 12 characters.')
  const crypto = webCrypto()
  const id = crypto.randomUUID()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(passphrase, salt)
  const verifier = await encryptEnvelope(key, new TextEncoder().encode(verifierText), {
    vaultId: id, mediaId: id, purpose: 'vault-check',
  })
  return {
    config: {
      version: 1, id,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toBase64(salt) },
      verifier: toBase64(verifier),
    },
    key,
  }
}

export async function unlockVault(passphrase: string, config: VaultConfig): Promise<CryptoKey> {
  validateVaultConfig(config)
  const key = await deriveKey(passphrase, fromBase64(config.kdf.salt))
  const plaintext = await decryptEnvelope(key, fromBase64(config.verifier), {
    vaultId: config.id, mediaId: config.id, purpose: 'vault-check',
  })
  if (new TextDecoder().decode(plaintext) !== verifierText) {
    throw new Error('Unable to decrypt: wrong passphrase or damaged data.')
  }
  return key
}
