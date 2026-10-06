/**
 * Where signatures come from. The API client and the vault tools only need an address and two
 * signing calls, so a raw private key (`BEAMSWAP_WALLET_KEY`) and MetaMask Agent Wallet
 * (`BEAMSWAP_SIGNER=metamask`, the `mm` CLI whose keys stay in MetaMask's TEE or a local
 * mnemonic) sit behind one interface. Nothing here ever logs a payload or the CLI's output.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/** EIP-712 data in the plain shape both viem and the x402 signer hand over. */
export interface TypedData {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

/** A failure whose message is safe to show the agent: it never carries a payload or CLI output. */
export class SignerError extends Error {}

export interface WalletSigner {
  address: Address
  /** `intent` is a short human reason shown where the signer asks for approval; local keys ignore it. */
  signTypedData(data: TypedData, intent?: string): Promise<Hex>
  /** EIP-191 `personal_sign` of the text. */
  signMessage(message: string): Promise<Hex>
}

export function localKeySigner(key: Hex): WalletSigner {
  const account = privateKeyToAccount(key)
  return {
    address: account.address,
    signTypedData: (data) =>
      account.signTypedData(data as Parameters<typeof account.signTypedData>[0]),
    signMessage: (message) => account.signMessage({ message }),
  }
}

export interface ExecOptions {
  timeout: number
  maxBuffer: number
}

/** Runs a binary with an argv array (never a shell) and returns its stdout. Injected in tests. */
export type ExecFn = (
  file: string,
  args: string[],
  opts: ExecOptions,
) => Promise<{ stdout: string }>

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((done, fail) => {
    execFile(
      file,
      args,
      { ...opts, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) return fail(Object.assign(error, { stderr }))
        done({ stdout })
      },
    )
  })

export interface MetamaskSignerOptions {
  exec?: ExecFn
  /** The `mm` command, or a path to its JS entry. Defaults to `BEAMSWAP_MM_BIN`, then `mm`. */
  bin?: string
  chainId?: number
  /** Covers a 2FA approval, so it is far longer than a normal call. */
  timeoutMs?: number
}

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/
const BIN_HINT = 'Install @metamask/agent-wallet or set BEAMSWAP_MM_BIN to the mm executable.'

/**
 * Node refuses to run `.cmd` files without a shell (CVE-2024-27980) and a shell would put the
 * payload in a command string. The npm shim only calls `node <js entry> %*`, so read the entry out
 * of it and run that with this Node instead.
 */
export function resolveMmCommand(
  bin: string,
  platform: NodeJS.Platform = process.platform,
  pathEnv: string = process.env.PATH ?? '',
  files: { exists(p: string): boolean; read(p: string): string } = {
    exists: existsSync,
    read: (p) => readFileSync(p, 'utf8'),
  },
): { file: string; prefix: string[] } {
  if (/\.[cm]?js$/i.test(bin)) return { file: process.execPath, prefix: [bin] }
  if (platform !== 'win32') return { file: bin, prefix: [] }
  const path = platform === 'win32' ? win32 : posix
  const isShim = (p: string) => /\.(?:cmd|bat)$/i.test(p)
  const candidates = /[\\/]/.test(bin)
    ? [bin]
    : pathEnv.split(path.delimiter).map((d) => path.join(d, bin))
  const shim = candidates
    .flatMap((c) => (isShim(c) ? [c] : [`${c}.cmd`]))
    .find((c) => files.exists(c))
  if (!shim) throw new SignerError(`Could not find the mm command. ${BIN_HINT}`)
  const entry = /"%dp0%\\([^"]+\.[cm]?js)"/i.exec(files.read(shim))?.[1]
  const target = entry ? path.resolve(path.dirname(shim), entry) : undefined
  if (!target || !files.exists(target)) {
    throw new SignerError(`Could not read the mm launcher on Windows. ${BIN_HINT}`)
  }
  return { file: process.execPath, prefix: [target] }
}

/** Typed data to JSON with bigints as decimal strings, so no wei value ever passes through Number. */
function payloadJson(data: TypedData): string {
  return JSON.stringify(
    {
      domain: data.domain,
      types: data.types,
      primaryType: data.primaryType,
      message: data.message,
    },
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
  )
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** Top-level, then `data`, then `result`: the CLI's envelope is not documented. */
function field(output: unknown, name: string): unknown {
  const top = asObject(output)
  for (const layer of [top, asObject(top?.data), asObject(top?.result)]) {
    if (layer && layer[name] !== undefined) return layer[name]
  }
  return undefined
}

/** The whole output as JSON, or the outermost `{...}` when the CLI printed log lines around it. */
function parseOutput(stdout: string): unknown {
  const text = stdout.trim()
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next shape
    }
  }
  return undefined
}

export async function metamaskSigner(opts: MetamaskSignerOptions = {}): Promise<WalletSigner> {
  const exec = opts.exec ?? defaultExec
  const chainId = opts.chainId ?? 8453
  const timeout = opts.timeoutMs ?? 11 * 60_000
  const bin = opts.bin ?? (process.env.BEAMSWAP_MM_BIN || 'mm')
  // A stub exec has no real binary to resolve, so only the default path touches the filesystem.
  const command = opts.exec ? { file: bin, prefix: [] as string[] } : resolveMmCommand(bin)

  async function run(args: string[]): Promise<{ stdout: string; parsed: unknown }> {
    try {
      const { stdout } = await exec(command.file, [...command.prefix, ...args], {
        timeout,
        maxBuffer: 1_048_576,
      })
      return { stdout, parsed: parseOutput(stdout) }
    } catch (error) {
      const e = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown }
      if (e.code === 'ENOENT') throw new SignerError(`The mm command was not found. ${BIN_HINT}`)
      if (e.code === 'ETIMEDOUT' || e.killed || e.signal === 'SIGTERM') {
        throw new SignerError(
          'MetaMask did not answer in time. Approve the request in MetaMask, then retry.',
        )
      }
      // Never the error message: Node puts the full command line, payload included, in it.
      const detail =
        typeof e.stderr === 'string' ? (e.stderr.trim().split('\n')[0] ?? '').slice(0, 200) : ''
      throw new SignerError(`The mm command failed${detail ? `: ${detail}` : ''}`)
    }
  }

  function signatureOf(out: { parsed: unknown }): Hex {
    const signature = field(out.parsed, 'signature')
    if (typeof signature === 'string' && SIGNATURE.test(signature)) return signature as Hex
    if (signature === undefined && field(out.parsed, 'pollingId') !== undefined) {
      throw new SignerError('Approval pending in MetaMask (2FA). Approve it, then retry.')
    }
    throw new SignerError(
      signature === undefined
        ? 'The mm command returned no signature.'
        : 'The mm command returned a signature that is not a 65-byte ECDSA signature.',
    )
  }

  const out = await run(['wallet', 'address', '--json'])
  const reported = field(out.parsed, 'address')
  const candidate =
    typeof reported === 'string' ? reported : /0x[0-9a-fA-F]{40}\b/.exec(out.stdout)?.[0]
  if (!candidate || !isAddress(candidate, { strict: false })) {
    throw new SignerError('Could not read the wallet address from `mm wallet address --json`.')
  }
  const address = getAddress(candidate)

  return {
    address,
    async signTypedData(data, intent) {
      const args = [
        'wallet',
        'sign-typed-data',
        '--chain-id',
        String(chainId),
        '--payload',
        payloadJson(data),
        '--wait',
        '--json',
      ]
      if (intent) args.push('--intent', intent)
      return signatureOf(await run(args))
    },
    async signMessage(message) {
      return signatureOf(
        await run([
          'wallet',
          'sign-message',
          '--message',
          message,
          '--chain-id',
          String(chainId),
          '--wait',
          '--json',
        ]),
      )
    },
  }
}
