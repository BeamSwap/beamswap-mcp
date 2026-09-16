import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RecoveryRecord {
  id: string
  createdAt: string
  origin: string
  fingerprint: string
}
export interface RecoveryStore {
  read(wallet: string): Promise<RecoveryRecord | null>
  acquire(wallet: string, record: RecoveryRecord): Promise<boolean>
  clear(wallet: string, expectedId: string): Promise<void>
}

export function recoveryRecord(
  origin: string,
  method: string,
  url: string,
  body = '',
): RecoveryRecord {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    origin,
    fingerprint: createHash('sha256').update(`${method}\n${url}\n${body}`).digest('hex'),
  }
}

/** One durable lock per wallet, shared across processes and API origins. No credentials saved. */
export function fileRecoveryStore(
  directory = join(homedir(), '.beamswap', 'mcp-payments'),
): RecoveryStore {
  const file = (wallet: string) =>
    join(directory, `${createHash('sha256').update(wallet.toLowerCase()).digest('hex')}.json`)
  async function read(wallet: string): Promise<RecoveryRecord | null> {
    try {
      const value = JSON.parse(await readFile(file(wallet), 'utf8')) as RecoveryRecord
      if (!value || typeof value.id !== 'string') throw new Error('Invalid recovery record')
      return value
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('Cannot read payment recovery state; payment is blocked')
    }
  }
  return {
    read,
    async acquire(wallet, record) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      let handle
      try {
        handle = await open(file(wallet), 'wx', 0o600)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw e
      }
      try {
        await handle.writeFile(JSON.stringify(record))
        await handle.sync()
      } finally {
        await handle.close()
      }
      return true
    },
    async clear(wallet, expectedId) {
      if ((await read(wallet))?.id !== expectedId) throw new Error('Recovery ID does not match')
      await unlink(file(wallet))
    },
  }
}

/** Test-only store. Production uses durable disk state even after a process restart. */
export function memoryRecoveryStore(): RecoveryStore {
  const records = new Map<string, RecoveryRecord>()
  return {
    async read(wallet) {
      return records.get(wallet.toLowerCase()) ?? null
    },
    async acquire(wallet, record) {
      const key = wallet.toLowerCase()
      if (records.has(key)) return false
      records.set(key, record)
      return true
    },
    async clear(wallet, id) {
      if (records.get(wallet.toLowerCase())?.id !== id)
        throw new Error('Recovery ID does not match')
      records.delete(wallet.toLowerCase())
    },
  }
}
