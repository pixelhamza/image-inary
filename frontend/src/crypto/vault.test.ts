import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fromBase64, toBase64 } from './envelope'
import { createVault, KDF_ITERATIONS, unlockVault, validateVaultConfig, type VaultConfig } from './vault'

const passphrase = 'synthetic test passphrase only'
let vault: Awaited<ReturnType<typeof createVault>>
beforeAll(async () => { vault = await createVault(passphrase) })

describe('vault configuration and unlock', () => {
  it('uses public versioned configuration and a non-extractable AES-256 KEK', () => {
    expect(vault.config.kdf.iterations).toBe(KDF_ITERATIONS)
    expect(fromBase64(vault.config.kdf.salt).length).toBe(16)
    expect(vault.key.extractable).toBe(false)
    expect(vault.key.algorithm).toEqual({ name: 'AES-GCM', length: 256 })
    expect(() => validateVaultConfig(vault.config)).not.toThrow()
    expect(JSON.stringify(vault.config)).not.toContain(passphrase)
  })

  it('unlocks from serialized public config without the original key', async () => {
    const restored: VaultConfig = JSON.parse(JSON.stringify(vault.config))
    const recovered = await unlockVault(passphrase, restored)
    expect(recovered.extractable).toBe(false)
    expect(recovered).not.toBe(vault.key)
  })

  it('fails safely with the wrong passphrase', async () => {
    await expect(unlockVault('a completely different password', vault.config)).rejects.toThrow('Unable to decrypt')
  })

  it('does not trim or normalize passphrases', async () => {
    await expect(unlockVault(` ${passphrase}`, vault.config)).rejects.toThrow('Unable to decrypt')
  })

  it('rejects tampered verifier ciphertext', async () => {
    const verifier = fromBase64(vault.config.verifier)
    verifier[verifier.length - 1] ^= 1
    await expect(unlockVault(passphrase, { ...vault.config, verifier: toBase64(verifier) })).rejects.toThrow('Unable to decrypt')
  })

  it('generates independent vault salts, IDs, and verifiers', async () => {
    const other = await createVault(passphrase)
    expect(other.config.id).not.toBe(vault.config.id)
    expect(other.config.kdf.salt).not.toBe(vault.config.kdf.salt)
    expect(other.config.verifier).not.toBe(vault.config.verifier)
  })

  it('requires a stronger passphrase when creating a vault', async () => {
    await expect(createVault('short')).rejects.toThrow('at least 12')
  })

  it('rejects malicious KDF work factors before derivation', async () => {
    const derive = vi.spyOn(crypto.subtle, 'deriveKey')
    try {
      await expect(unlockVault(passphrase, {
        ...vault.config, kdf: { ...vault.config.kdf, iterations: 2_000_000_000 },
      })).rejects.toThrow('unsupported vault configuration')
      expect(derive).not.toHaveBeenCalled()
    } finally { derive.mockRestore() }
  })

  it.each([null, {}, { version: 2 }, { kdf: null }])('rejects malformed config %j', (config) => {
    expect(() => validateVaultConfig(config)).toThrow()
  })

  it('rejects malformed salt and verifier encodings', () => {
    expect(() => validateVaultConfig({ ...vault.config, kdf: { ...vault.config.kdf, salt: '!'.repeat(24) } })).toThrow()
    expect(() => validateVaultConfig({ ...vault.config, verifier: '' })).toThrow()
  })
})
