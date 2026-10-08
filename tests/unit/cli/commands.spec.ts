import { describe, it, expect } from '@jest/globals'

import { CheckFailedError, runCommand, UsageError } from '#/cli/commands'
import type { CliServices } from '#/cli/commands'

const STORE = {
  id: '019fc5d3-5c00-7000-8000-000000000001',
  slug: 'zincomed',
  name: 'Zincomed',
  brandName: 'ZincoGroup Hub'
}

/** Fake services that record what they were asked to do. */
function setup(secretTyped = 'kk-typed-key-0001', readable = 'readable') {
  const calls: unknown[][] = []
  const lines: string[] = []
  const record
    = <T>(name: string, result: T) =>
      async (...args: unknown[]): Promise<T> => {
        calls.push([name, ...args])
        return result
      }

  const services = {
    stores: {
      create: record('stores.create', STORE),
      findBySlug: async (slug: string) => (slug === STORE.slug ? STORE : null),
      list: record('stores.list', [STORE])
    },
    tokens: {
      issue: record('tokens.issue', {
        id: 'token-id',
        token: 'phk_THE-ONE-AND-ONLY-TIME-THIS-TOKEN-IS-SHOWN-0000',
        prefix: 'THE-ONE-'
      }),
      list: record('tokens.list', []),
      revoke: record('tokens.revoke', 1)
    },
    kkCredential: {
      replace: record('kk.replace', {
        provider: 'kuantokusta',
        configured: true,
        lastFour: '0001',
        updatedAt: new Date('2026-10-08T12:00:00Z')
      }),
      status: record('kk.status', {
        provider: 'kuantokusta',
        configured: false,
        lastFour: null,
        updatedAt: null
      }),
      isReadable: record('kk.isReadable', readable)
    },
    kkOffersSync: {
      sync: record('kk.sync', {
        fetched: 347,
        created: 340,
        updated: 5,
        delisted: 0,
        skipped: { bad_price: 2 },
        delistingHeldBack: 'items_skipped',
        missing: 0,
        withoutSku: 45,
        withoutEan: 7,
        durationMs: 1200
      })
    },
    kkOffers: { count: record('kk.count', { listed: 345, delisted: 2 }) }
  } as unknown as CliServices

  const prompts: string[] = []
  const io = {
    write: (line: string) => lines.push(line),
    readSecret: async (prompt: string) => {
      prompts.push(prompt)
      return secretTyped
    }
  }
  const run = (...argv: string[]) => runCommand(argv, services, io)
  return { run, calls, lines, prompts }
}

const CLI = { type: 'system', label: 'cli' }

describe('operator commands', () => {
  it('creates a store', async () => {
    const { run, calls, lines } = setup()

    await run(
      'store:create',
      '--slug', 'zincomed',
      '--name', 'Zincomed',
      '--brand', 'ZincoGroup Hub'
    )

    expect(calls).toEqual([
      [
        'stores.create',
        { slug: 'zincomed', name: 'Zincomed', brandName: 'ZincoGroup Hub' },
        CLI
      ]
    ])
    expect(lines.join('\n')).toContain('ZincoGroup Hub')
  })

  it('issues a token with every scope by default and shows it once', async () => {
    const { run, calls, lines } = setup()

    await run('token:issue', '--store', 'zincomed', '--label', 'WordPress')

    expect(calls).toEqual([
      [
        'tokens.issue',
        {
          storeId: STORE.id,
          label: 'WordPress',
          scopes: ['credentials:write', 'prices:read', 'prices:refresh'],
          expiresAt: undefined
        },
        CLI
      ]
    ])
    const shown = lines.filter((line) => line.includes('phk_'))

    expect(shown).toEqual([
      '  phk_THE-ONE-AND-ONLY-TIME-THIS-TOKEN-IS-SHOWN-0000'
    ])
    expect(lines.join('\n')).toContain('only time it is shown')
  })

  it('issues a token limited to the scopes and days asked for', async () => {
    const { run, calls } = setup()
    const before = Date.now()

    await run(
      'token:issue',
      '--store', 'zincomed',
      '--label', 'Read only',
      '--scopes', 'prices:read',
      '--expires-in-days', '30'
    )

    const [, input] = calls[0] as [string, { scopes: string[], expiresAt: Date }]

    expect(input.scopes).toEqual(['prices:read'])
    expect(input.expiresAt.getTime() - before).toBeGreaterThanOrEqual(
      30 * 86_400_000
    )
    expect(input.expiresAt.getTime() - before).toBeLessThan(
      30 * 86_400_000 + 5000
    )
  })

  it('revokes by prefix, within the named store only', async () => {
    const { run, calls } = setup()

    await run('token:revoke', '--store', 'zincomed', '--prefix', 'ab12cd34')

    expect(calls).toEqual([
      ['tokens.revoke', { storeId: STORE.id, prefix: 'ab12cd34' }, CLI]
    ])
  })

  it('asks for the KuantoKusta key instead of taking it as an argument', async () => {
    const { run, calls, lines, prompts } = setup('  kk-typed-key-0001\n')

    await run('kk:set-key', '--store', 'zincomed')

    expect(prompts).toHaveLength(1)
    expect(calls).toEqual([['kk.replace', STORE.id, 'kk-typed-key-0001', CLI]])
    expect(lines.join('\n')).toContain('ending in 0001')
    expect(lines.join('\n')).not.toContain('kk-typed-key')
  })

  it('refuses a key passed on the command line', async () => {
    const { run, calls } = setup()

    await expect(
      run('kk:set-key', '--store', 'zincomed', '--key', 'kk-on-argv')
    ).rejects.toThrow(UsageError)
    await expect(
      run('kk:set-key', '--store', 'zincomed', 'kk-on-argv')
    ).rejects.toThrow(UsageError)
    expect(calls).toEqual([])
  })

  it('refuses an empty key', async () => {
    const { run, calls } = setup('   ')

    await expect(run('kk:set-key', '--store', 'zincomed')).rejects.toThrow(
      'No key was entered'
    )
    expect(calls).toEqual([])
  })

  it('reports what a sync did, including what it left out', async () => {
    const { run, calls, lines } = setup()

    await run('kk:sync-offers', '--store', 'zincomed')

    expect(calls).toEqual([
      ['kk.sync', STORE.id, CLI, { allowMassDelisting: false }]
    ])
    const output = lines.join('\n')

    expect(output).toContain('returned by the API: 347')
    expect(output).toContain('new:                 340')
    expect(output).toContain('without SKU / EAN:   45 / 7')
    expect(output).toContain('skipped (bad_price): 2')
    expect(output).toContain('no offer was marked as delisted')
  })

  it('delists many offers at once only when told to', async () => {
    const { run, calls } = setup()

    await run('kk:sync-offers', '--store', 'zincomed', '--allow-mass-delisting')

    expect(calls).toEqual([
      ['kk.sync', STORE.id, CLI, { allowMassDelisting: true }]
    ])
  })

  it('checks that every stored key can still be decrypted', async () => {
    const fine = setup()
    await fine.run('kk:check-keys')

    expect(fine.lines).toEqual(['zincomed\treadable'])

    const broken = setup('x', 'unreadable')
    const error = await broken.run('kk:check-keys').catch((e: unknown) => e)

    expect(broken.lines).toEqual(['zincomed\tunreadable'])
    expect(error).toBeInstanceOf(CheckFailedError)
    expect((error as Error).message).toContain('CREDENTIALS_MASTER_KEY')
  })

  it('shows the status without any secret', async () => {
    const { run, lines } = setup()

    await run('kk:status', '--store', 'zincomed')

    expect(lines).toEqual([
      'Key: not configured',
      'Offers: 345 listed, 2 delisted'
    ])
  })

  it.each([
    [[], 'No command given'],
    [['store:destroy'], 'Unknown command: store:destroy'],
    [['store:create', '--slug', 'x'], '--name is required'],
    [['store:create', '--name', 'X'], '--slug is required'],
    [['token:issue', '--label', 'x'], '--store is required'],
    [['token:issue', '--store', 'nope', '--label', 'x'], 'no store with the slug "nope"'],
    [['token:issue', '--store', 'zincomed'], '--label is required'],
    [['token:issue', '--store', 'zincomed', '--label', 'x', '--scopes', 'admin'], '--scopes must be'],
    [['token:issue', '--store', 'zincomed', '--label', 'x', '--scopes', ','], '--scopes must be'],
    [['token:issue', '--store', 'zincomed', '--label', 'x', '--expires-in-days', '0'], '--expires-in-days'],
    [['token:issue', '--store', 'zincomed', '--label', 'x', '--expires-in-days', '1.5'], '--expires-in-days'],
    [['token:revoke', '--store', 'zincomed'], '--prefix is required'],
    [['kk:sync-offers'], '--store is required'],
    [['kk:sync-offers', '--store', 'zincomed', '--force'], 'Unknown option'],
    [['kk:sync-offers', '--store', 'zincomed', '--allow-mass-delisting=yes'], 'does not take an argument'],
    [['kk:check-keys', '--store', 'zincomed'], 'Unknown option']
  ])('rejects %j', async (argv, message) => {
    const { run, calls } = setup()

    const error = await run(...(argv as string[])).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(UsageError)
    expect((error as Error).message).toContain(message)
    expect(calls).toEqual([])
  })
})
