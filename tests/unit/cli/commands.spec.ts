import { describe, it, expect } from '@jest/globals'

import { CheckFailedError, runCommand, UsageError } from '#/cli/commands'
import type { CliServices } from '#/cli/commands'
import { RunTooSoonError } from '#/modules/kuantokusta/services/collection-runs.service'
import {
  InvalidKkSettingsError,
  KkIdentityTakenError
} from '#/modules/kuantokusta/services/kk-store-settings.service'

const STORE = {
  id: '019fc5d3-5c00-7000-8000-000000000001',
  slug: 'zincomed',
  name: 'Zincomed',
  brandName: 'ZincoGroup Hub'
}

const RUN = {
  id: '019fc5d3-5c00-7000-8000-0000000000aa',
  status: 'succeeded',
  trigger: 'manual',
  requestedBy: 'cli',
  itemsTotal: 346,
  itemsOk: 340,
  itemsFailed: 6,
  errorCode: null,
  queuedAt: new Date('2026-10-08T12:00:00Z'),
  startedAt: new Date('2026-10-08T12:00:05Z'),
  finishedAt: new Date('2026-10-08T12:31:00Z')
}

interface Fakes {
  keyConfigured?: boolean
  runs?: unknown[]
  request?: () => Promise<unknown>
  settings?: unknown
  setIdentity?: () => Promise<void>
}

/** Fake services that record what they were asked to do. */
function setup(
  secretTyped = 'kk-typed-key-0001',
  readable = 'readable',
  fakes: Fakes = {}
) {
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
        configured: fakes.keyConfigured ?? false,
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
    kkOffers: { count: record('kk.count', { listed: 345, delisted: 2 }) },
    kkRuns: {
      request: async (...args: unknown[]) => {
        calls.push(['runs.request', ...args])
        return fakes.request
          ? fakes.request()
          : { run: { ...RUN, status: 'queued' }, created: true }
      },
      list: async () => fakes.runs ?? [],
      summary: async () => ({
        cheapest: 120,
        tied: 15,
        more_expensive: 190,
        only_store: 15,
        no_data: 6
      })
    },
    kkSettings: {
      get: async () => fakes.settings ?? null,
      setIdentity: async (...args: unknown[]) => {
        calls.push(['settings.setIdentity', ...args])
        await fakes.setIdentity?.()
      },
      setEasyAdjust: record('settings.setEasyAdjust', undefined)
    }
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
      'Offers: 345 listed, 2 delisted',
      'Appears on KuantoKusta as: not known yet '
      + '(the first collection works it out)',
      'Latest collection: none yet'
    ])
  })

  it('shows how the store was recognised and how the last collection went', async () => {
    const { run, lines } = setup('x', 'readable', {
      settings: {
        identity: { storeSlug: 'zincomed', sellerId: 4321 },
        easyAdjustCents: 10
      },
      runs: [{ ...RUN, status: 'blocked', errorCode: 'blocked_by_site' }]
    })

    await run('kk:status', '--store', 'zincomed')

    expect(lines.slice(2)).toEqual([
      'Appears on KuantoKusta as: zincomed (seller id 4321); '
      + 'easy adjust up to 10 cents',
      'Latest collection: blocked (blocked_by_site), '
      + 'asked for 2026-10-08T12:00:00.000Z'
    ])
  })

  describe('kk:collect', () => {
    it('queues a collection and says how to follow it', async () => {
      const { run, calls, lines } = setup('x', 'readable', {
        keyConfigured: true
      })

      await run('kk:collect', '--store', 'zincomed')

      expect(calls.filter(([name]) => name === 'runs.request')).toEqual([
        [
          'runs.request',
          STORE.id,
          { trigger: 'manual', requestedBy: 'cli', ignoreWait: false },
          CLI
        ]
      ])
      expect(lines[0]).toBe(`Collection queued for "zincomed": ${RUN.id}`)
      expect(lines.join('\n')).toContain('kk:runs --store zincomed')
    })

    it('says so when one is already waiting or running', async () => {
      const { run, lines } = setup('x', 'readable', {
        keyConfigured: true,
        request: async () => ({
          run: { ...RUN, status: 'running' },
          created: false
        })
      })

      await run('kk:collect', '--store', 'zincomed')

      expect(lines[0]).toBe(
        `"zincomed" already has a collection running: ${RUN.id}`
      )
    })

    it('does not queue anything for a store without a key', async () => {
      const { run, calls } = setup()

      const error = await run('kk:collect', '--store', 'zincomed')
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(CheckFailedError)
      expect((error as Error).message).toContain('kk:set-key')
      expect(calls.some(([name]) => name === 'runs.request')).toBe(false)
    })

    it('explains the wait after a recent collection, and how to skip it', async () => {
      const waiting = setup('x', 'readable', {
        keyConfigured: true,
        request: async () => {
          throw new RunTooSoonError(11 * 60 + 1)
        }
      })

      const error = await waiting.run('kk:collect', '--store', 'zincomed')
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(CheckFailedError)
      expect((error as Error).message).toContain('wait 12 minute(s)')
      expect((error as Error).message).toContain('--ignore-wait')

      const forced = setup('x', 'readable', { keyConfigured: true })
      await forced.run('kk:collect', '--store', 'zincomed', '--ignore-wait')

      expect(forced.calls.at(-1)?.[2]).toEqual({
        trigger: 'manual',
        requestedBy: 'cli',
        ignoreWait: true
      })
    })
  })

  describe('kk:runs', () => {
    it('lists the collections and sums up the latest one', async () => {
      const { run, lines } = setup('x', 'readable', {
        runs: [
          RUN,
          {
            ...RUN,
            id: 'older',
            status: 'failed',
            errorCode: 'kk_key_rejected',
            trigger: 'schedule',
            requestedBy: null,
            itemsTotal: 0,
            itemsOk: 0,
            itemsFailed: 0
          }
        ]
      })

      await run('kk:runs', '--store', 'zincomed')

      expect(lines).toEqual([
        '2026-10-08T12:00:00.000Z\tsucceeded\t'
        + `pages read 340, not read 6, of 346\tby cli\t${RUN.id}`,
        '2026-10-08T12:00:00.000Z\tfailed (kk_key_rejected)\t'
        + 'pages read 0, not read 0, of 0\tscheduled\tolder',
        '',
        'Latest collection, offer by offer:',
        '  cheapest:           120',
        '  tied for cheapest:  15',
        '  more expensive:     190',
        '  only store selling: 15',
        '  page not read:      6'
      ])
    })

    it('shows no summary while the latest one is still going', async () => {
      const { run, lines } = setup('x', 'readable', {
        runs: [{ ...RUN, status: 'running', finishedAt: null }]
      })

      await run('kk:runs', '--store', 'zincomed')

      expect(lines).toHaveLength(1)
    })

    it('says so when there is none', async () => {
      const { run, lines } = setup()

      await run('kk:runs', '--store', 'zincomed')

      expect(lines).toEqual(['No collections yet.'])
    })
  })

  describe('kk:configure', () => {
    it('sets how the store appears on KuantoKusta and the threshold', async () => {
      const { run, calls, lines } = setup('x', 'readable', {
        settings: {
          identity: { storeSlug: 'zincomed', sellerId: null },
          easyAdjustCents: 15
        }
      })

      await run(
        'kk:configure',
        '--store', 'zincomed',
        '--kk-slug', 'zincomed',
        '--easy-adjust-cents', '15'
      )

      expect(calls).toEqual([
        [
          'settings.setIdentity',
          STORE.id,
          { storeSlug: 'zincomed', sellerId: null }
        ],
        ['settings.setEasyAdjust', STORE.id, 15, { type: 'system', label: 'cli' }]
      ])
      expect(lines).toEqual([
        'Settings of "zincomed" for KuantoKusta:',
        '  appears on KuantoKusta as: zincomed',
        '  seller id:                 not known yet',
        '  easy adjust up to:         15 cents'
      ])
    })

    it('accepts a seller id together with the slug', async () => {
      const { run, calls } = setup()

      await run(
        'kk:configure',
        '--store', 'zincomed',
        '--kk-slug', 'zincomed',
        '--seller-id', '4321'
      )

      expect(calls).toEqual([
        [
          'settings.setIdentity',
          STORE.id,
          { storeSlug: 'zincomed', sellerId: 4321 }
        ]
      ])
    })

    it.each([
      [new KkIdentityTakenError(), 'Another store'],
      [new InvalidKkSettingsError('The slug is wrong'), 'The slug is wrong']
    ])('explains a refusal without the usage text', async (thrown, message) => {
      const { run } = setup('x', 'readable', {
        setIdentity: async () => {
          throw thrown
        }
      })

      const error = await run(
        'kk:configure',
        '--store', 'zincomed',
        '--kk-slug', 'zincomed'
      ).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(CheckFailedError)
      expect((error as Error).message).toContain(message)
    })
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
    [['kk:check-keys', '--store', 'zincomed'], 'Unknown option'],
    [['kk:collect'], '--store is required'],
    [['kk:collect', '--store', 'zincomed', '--ignore-wait=1'], 'does not take an argument'],
    [['kk:runs', '--store', 'nope'], 'no store with the slug "nope"'],
    [['kk:configure', '--store', 'zincomed'], 'Nothing to change'],
    [['kk:configure', '--store', 'zincomed', '--seller-id', '7'], '--seller-id needs --kk-slug'],
    [['kk:configure', '--store', 'zincomed', '--kk-slug', 'z', '--seller-id', 'x'], '--seller-id must be a whole number'],
    [['kk:configure', '--store', 'zincomed', '--easy-adjust-cents', '-5'], '--easy-adjust-cents'],
    [['kk:configure', '--store', 'zincomed', '--easy-adjust-cents', '1.5'], '--easy-adjust-cents must be a whole number'],
    [['kk:configure', '--store', 'zincomed', '--easy-adjust-cents', '100001'], '--easy-adjust-cents must be a whole number']
  ])('rejects %j', async (argv, message) => {
    const { run, calls } = setup()

    const error = await run(...(argv as string[])).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(UsageError)
    expect((error as Error).message).toContain(message)
    expect(calls).toEqual([])
  })
})
