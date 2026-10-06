import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  localKeySigner,
  metamaskSigner,
  resolveMmCommand,
  type ExecFn,
  type TypedData,
} from './signer'

const key = `0x${'11'.repeat(32)}` as const
const account = privateKeyToAccount(key)
const address = '0x1111111111111111111111111111111111111111'
const sig = `0x${'ab'.repeat(65)}`

/** A stub `mm`: answers `wallet address` with the address and everything else with `signing`. */
function stub(signing: string | (() => Promise<{ stdout: string }>), addressOut?: string) {
  const calls: Array<{
    file: string
    args: string[]
    opts: { timeout: number; maxBuffer: number }
  }> = []
  const exec: ExecFn = async (file, args, opts) => {
    calls.push({ file, args, opts })
    if (args[1] === 'address') return { stdout: addressOut ?? JSON.stringify({ address }) }
    return typeof signing === 'string' ? { stdout: signing } : signing()
  }
  return { exec, calls }
}

const typed: TypedData = {
  domain: { name: 'Test', chainId: 8453n },
  types: { Msg: [{ name: 'amount', type: 'uint256' }] },
  primaryType: 'Msg',
  message: { amount: 123456789012345678901234567890n },
}

describe('localKeySigner', () => {
  it('signs with the key it wraps', async () => {
    const signer = localKeySigner(key)
    expect(signer.address).toBe(account.address)
    expect(await signer.signMessage('hello')).toBe(await account.signMessage({ message: 'hello' }))
  })
})

describe('metamaskSigner', () => {
  it('reads the address once, from the top level or under data, or from raw text', async () => {
    for (const out of [
      JSON.stringify({ address }),
      JSON.stringify({ data: { address } }),
      JSON.stringify({ result: { address } }),
      `active wallet ${address}\n`,
    ]) {
      const { exec, calls } = stub(JSON.stringify({ signature: sig }), out)
      const signer = await metamaskSigner({ exec, bin: 'mm' })
      expect(signer.address).toBe(address)
      expect(calls.map((c) => c.args)).toEqual([['wallet', 'address', '--json']])
    }
  })

  it('returns the checksummed address', async () => {
    const lower = account.address.toLowerCase()
    const { exec } = stub('{}', JSON.stringify({ address: lower }))
    expect((await metamaskSigner({ exec })).address).toBe(account.address)
  })

  it('refuses output that holds no address', async () => {
    await expect(metamaskSigner({ exec: stub('{}', 'garbage').exec })).rejects.toThrow(
      /wallet address/,
    )
    await expect(
      metamaskSigner({ exec: stub('{}', JSON.stringify({ address: '0x12' })).exec }),
    ).rejects.toThrow(/wallet address/)
  })

  it.each([
    ['top level', { signature: sig }],
    ['under data', { data: { signature: sig } }],
    ['under result', { result: { signature: sig } }],
  ])('reads the signature %s', async (_name, output) => {
    const signer = await metamaskSigner({ exec: stub(JSON.stringify(output)).exec })
    expect(await signer.signMessage('hi')).toBe(sig)
    expect(await signer.signTypedData(typed)).toBe(sig)
  })

  it('tolerates log lines around the JSON', async () => {
    const signer = await metamaskSigner({
      exec: stub(`warming up\n${JSON.stringify({ signature: sig })}\n`).exec,
    })
    expect(await signer.signMessage('hi')).toBe(sig)
  })

  it('rejects garbage, a missing signature and anything that is not 65 bytes', async () => {
    for (const [out, message] of [
      ['not json at all', /no signature/],
      [JSON.stringify({ ok: true }), /no signature/],
      [JSON.stringify({ signature: `0x${'ab'.repeat(64)}` }), /65-byte/],
      [JSON.stringify({ signature: `0x${'ab'.repeat(66)}` }), /65-byte/],
      [JSON.stringify({ signature: `0x${'zz'.repeat(65)}` }), /65-byte/],
      [JSON.stringify({ signature: 5 }), /65-byte/],
    ] as const) {
      const signer = await metamaskSigner({ exec: stub(out).exec })
      await expect(signer.signMessage('hi')).rejects.toThrow(message)
    }
  })

  it('says when the approval is still pending 2FA', async () => {
    const signer = await metamaskSigner({
      exec: stub(JSON.stringify({ data: { pollingId: 'p-1' } })).exec,
    })
    await expect(signer.signTypedData(typed)).rejects.toThrow(
      'Approval pending in MetaMask (2FA). Approve it, then retry.',
    )
  })

  it('reports a timeout and a missing binary without the command line', async () => {
    const timedOut = Object.assign(new Error(`Command failed: mm --payload ${'x'.repeat(50)}`), {
      killed: true,
      code: null,
      signal: 'SIGTERM',
    })
    const slow = await metamaskSigner({
      exec: stub(() => Promise.reject(timedOut)).exec,
    })
    const error = await slow.signMessage('hi').catch((e: Error) => e)
    expect((error as Error).message).toMatch(/did not answer in time/)
    expect((error as Error).message).not.toContain('--payload')

    const missing = Object.assign(new Error('spawn mm ENOENT'), { code: 'ENOENT' })
    await expect(metamaskSigner({ exec: async () => Promise.reject(missing) })).rejects.toThrow(
      /BEAMSWAP_MM_BIN/,
    )
  })

  it('surfaces only the first line of stderr when the command fails', async () => {
    const failing = Object.assign(new Error('Command failed: mm secret-args'), {
      code: 1,
      stderr: 'Not logged in\nstack trace',
    })
    const signer = await metamaskSigner({ exec: stub(() => Promise.reject(failing)).exec })
    await expect(signer.signMessage('hi')).rejects.toThrow('The mm command failed: Not logged in')
  })

  it("surfaces the CLI's own JSON error message", async () => {
    const json = JSON.stringify(
      {
        ok: false,
        error: { code: 'AUTH_FAILED', message: 'No CLI refresh token available — run `mm login`.' },
      },
      null,
      2,
    )
    const failing = Object.assign(new Error('Command failed: mm secret-args'), {
      code: 1,
      stdout: json,
      stderr: json,
    })
    const signer = await metamaskSigner({ exec: stub(() => Promise.reject(failing)).exec })
    const error = (await signer.signMessage('hi').catch((e: Error) => e)) as Error
    expect(error.message).toBe(
      'The mm command failed: No CLI refresh token available — run `mm login`.',
    )
    expect(error.message).not.toContain('secret-args')
  })

  it('passes the payload as one argv element, with bigints as decimal strings', async () => {
    const { exec, calls } = stub(JSON.stringify({ signature: sig }))
    const signer = await metamaskSigner({ exec, bin: 'mm', chainId: 8453 })
    await signer.signTypedData(typed, 'Beamswap API payment of 0.01 USDC')
    const { file, args, opts } = calls[1]!
    expect(file).toBe('mm')
    expect(args.slice(0, 6)).toEqual([
      'wallet',
      'sign-typed-data',
      '--chain-id',
      '8453',
      '--payload',
      args[5],
    ])
    expect(args.slice(6)).toEqual([
      '--wait',
      '--json',
      '--intent',
      'Beamswap API payment of 0.01 USDC',
    ])
    expect(JSON.parse(args[5]!)).toEqual({
      domain: { name: 'Test', chainId: '8453' },
      types: typed.types,
      primaryType: 'Msg',
      message: { amount: '123456789012345678901234567890' },
    })
    expect(opts).toEqual({ timeout: 11 * 60_000, maxBuffer: 1_048_576 })
  })

  it('signs a message with the chain id and no shell quoting of the text', async () => {
    const { exec, calls } = stub(JSON.stringify({ signature: sig }))
    const signer = await metamaskSigner({ exec, chainId: 1, timeoutMs: 5_000 })
    await signer.signMessage('Beamswap vault prepare 0xabc 1; rm -rf "$HOME"')
    expect(calls[1]!.args).toEqual([
      'wallet',
      'sign-message',
      '--message',
      'Beamswap vault prepare 0xabc 1; rm -rf "$HOME"',
      '--chain-id',
      '1',
      '--wait',
      '--json',
    ])
    expect(calls[1]!.opts.timeout).toBe(5_000)
  })
})

describe('resolveMmCommand', () => {
  const shim = 'C:\\npm\\mm.cmd'
  const entry = 'C:\\npm\\node_modules\\@metamask\\agent-wallet\\dist\\cli.js'
  const cmd = [
    '@ECHO off',
    'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")',
    '"%_prog%"  "%dp0%\\node_modules\\@metamask\\agent-wallet\\dist\\cli.js" %*',
  ].join('\r\n')
  const files = {
    exists: (p: string) => [shim, entry].includes(p),
    read: () => cmd,
  }

  it('runs the JS entry behind the npm shim with this Node on Windows', () => {
    expect(resolveMmCommand('mm', 'win32', 'C:\\bin;C:\\npm', files)).toEqual({
      file: process.execPath,
      prefix: [entry],
    })
  })

  it('runs the command directly elsewhere, and a .js entry through Node', () => {
    expect(resolveMmCommand('mm', 'linux')).toEqual({ file: 'mm', prefix: [] })
    expect(resolveMmCommand('/x/cli.js', 'linux')).toEqual({
      file: process.execPath,
      prefix: ['/x/cli.js'],
    })
  })

  it('explains what to set when the shim cannot be found or read', () => {
    expect(() => resolveMmCommand('mm', 'win32', 'C:\\bin', files)).toThrow(/BEAMSWAP_MM_BIN/)
    expect(() =>
      resolveMmCommand('mm', 'win32', 'C:\\npm', { exists: files.exists, read: () => 'nope' }),
    ).toThrow(/BEAMSWAP_MM_BIN/)
  })
})
