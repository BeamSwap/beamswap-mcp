import { hashTypedData } from 'viem'
import { describe, expect, it } from 'vitest'
import { buildSessionMessage } from './session'

describe('canonical API session compatibility', () => {
  it('matches the signing digest from the deployed API shared helper', () => {
    // Recorded from beamswap-app-base 4b6af23's shared helper, before extracting this package.
    // Guards domain, chain, field order/types, address and issuedAt encoding across repositories.
    const message = buildSessionMessage('0x1111111111111111111111111111111111111111', 1789516800)
    expect(hashTypedData(message)).toBe(
      '0xeeb9e902536a19bc4e8cfd7dadf77c573e630e5ec3ac6a586b39d6998d39f77a',
    )
  })
})
