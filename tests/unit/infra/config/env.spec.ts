import { randomBytes } from 'node:crypto'

import { describe, it, expect } from '@jest/globals'

import { EnvError, parseEnv } from '#/infra/config/env'

const keyOf = (version: number, bytes = randomBytes(32)) =>
  `${version}:${bytes.toString('base64')}`

const masterBytes = randomBytes(32)
const valid = {
  DATABASE_URL: 'postgresql://app:secret@localhost:5432/pharma_hub',
  CREDENTIALS_MASTER_KEY: keyOf(1, masterBytes)
}

function problemsOf(source: Record<string, string | undefined>): string[] {
  try {
    parseEnv(source)
  } catch (error) {
    if (error instanceof EnvError) return [...error.problems]
    throw error
  }
  throw new Error('parseEnv accepted an invalid environment')
}

describe('parseEnv', () => {
  it('applies defaults for optional variables', () => {
    expect(parseEnv(valid)).toEqual({
      NODE_ENV: 'production',
      PORT: 7000,
      DATABASE_URL: valid.DATABASE_URL,
      CREDENTIALS_MASTER_KEY: { version: 1, key: masterBytes },
      CREDENTIALS_PREVIOUS_KEYS: [],
      KK_SELLER_API_BASE_URL: 'https://seller.kuantokusta.pt/api',
      KK_SITE_BASE_URL: 'https://www.kuantokusta.pt',
      KK_COLLECTOR_USER_AGENT:
        'PharmaHubPriceReport/1.0 (price report for partner stores)'
    })
  })

  it('reads explicit values', () => {
    const env = parseEnv({ ...valid, PORT: '8080', NODE_ENV: 'development' })

    expect(env.PORT).toBe(8080)
    expect(env.NODE_ENV).toBe('development')
  })

  it('accepts the short postgres:// scheme', () => {
    const url = 'postgres://app:secret@localhost:5432/pharma_hub'

    expect(parseEnv({ ...valid, DATABASE_URL: url }).DATABASE_URL).toBe(url)
  })

  it('reports every problem at once, naming the variables', () => {
    const problems = problemsOf({ PORT: 'abc', NODE_ENV: 'staging' })

    expect(problems.map((problem) => problem.split(':')[0]).sort()).toEqual([
      'CREDENTIALS_MASTER_KEY',
      'DATABASE_URL',
      'NODE_ENV',
      'PORT'
    ])
  })

  it('says that the required variables are required', () => {
    expect(problemsOf({}).sort()).toEqual([
      'CREDENTIALS_MASTER_KEY: is required',
      'DATABASE_URL: is required'
    ])
  })

  it.each(['0', '70000', '3000.5', '-1', '30 00', ''])(
    'rejects PORT=%j',
    (port) => {
      expect(problemsOf({ ...valid, PORT: port })).toHaveLength(1)
    }
  )

  it.each([
    'mysql://root:hunter2@localhost/db',
    'hunter2',
    'https://user:hunter2@example.com'
  ])('rejects DATABASE_URL=%s without echoing it', (secret) => {
    const problems = problemsOf({ ...valid, DATABASE_URL: secret })

    expect(problems).toEqual([
      'DATABASE_URL: must be a postgresql:// connection string'
    ])
    expect(problems.join(' ')).not.toContain('hunter2')
  })

  it('does not echo a rejected NODE_ENV or PORT either', () => {
    const problems = problemsOf({
      ...valid,
      NODE_ENV: 'hunter2',
      PORT: 'hunter2'
    })

    expect(problems).toHaveLength(2)
    expect(problems.join(' ')).not.toContain('hunter2')
  })

  describe('CREDENTIALS_MASTER_KEY', () => {
    it.each([
      ['no version', randomBytes(32).toString('base64')],
      ['version zero', keyOf(0)],
      ['a version that is not a number', `v1:${randomBytes(32).toString('base64')}`],
      ['a key of 16 bytes', keyOf(1, randomBytes(16))],
      ['a key of 33 bytes', keyOf(1, randomBytes(33))],
      ['a key in hexadecimal', `1:${randomBytes(32).toString('hex')}`],
      ['a key of one repeated byte', keyOf(1, Buffer.alloc(32, 0))],
      ['the placeholder text', '1:change-me'],
      ['an empty value', '']
    ])('rejects %s, without echoing the value', (_case, value) => {
      const problems = problemsOf({ ...valid, CREDENTIALS_MASTER_KEY: value })

      expect(problems).toEqual([
        'CREDENTIALS_MASTER_KEY: must be '
        + '"<version>:<base64 of 32 random bytes>"'
      ])
      // A long enough piece of the value to be recognisable, when there is one.
      expect(problems.join(' ')).not.toContain(value.slice(2, 14) || '\u0000')
    })

    it('refuses the example key in production, and only there', () => {
      const example = keyOf(1, Buffer.from('local-development-only-not-a-key'))
      const source = { ...valid, CREDENTIALS_MASTER_KEY: example }

      expect(parseEnv({ ...source, NODE_ENV: 'development' })).toBeDefined()
      expect(problemsOf({ ...source, NODE_ENV: 'production' })).toEqual([
        'CREDENTIALS_MASTER_KEY: is the example key from .env.example; '
        + 'generate one with: openssl rand -base64 32'
      ])
      // Also when it hides among the previous keys.
      expect(
        problemsOf({ ...valid, CREDENTIALS_PREVIOUS_KEYS: keyOf(9, Buffer.from('local-development-only-not-a-key')) })
      ).toHaveLength(1)
    })

    it('tolerates spaces around the value', () => {
      const env = parseEnv({
        ...valid,
        CREDENTIALS_MASTER_KEY: ` ${valid.CREDENTIALS_MASTER_KEY}\n`
      })

      expect(env.CREDENTIALS_MASTER_KEY.key.equals(masterBytes)).toBe(true)
    })
  })

  describe('CREDENTIALS_PREVIOUS_KEYS', () => {
    it('reads a list of older keys', () => {
      const env = parseEnv({
        ...valid,
        CREDENTIALS_MASTER_KEY: keyOf(3),
        CREDENTIALS_PREVIOUS_KEYS: `${keyOf(1)}, ${keyOf(2)}`
      })

      expect(env.CREDENTIALS_PREVIOUS_KEYS.map((key) => key.version))
        .toEqual([1, 2])
    })

    it('rejects a malformed entry', () => {
      expect(
        problemsOf({ ...valid, CREDENTIALS_PREVIOUS_KEYS: `${keyOf(2)},oops` })
      ).toEqual([
        'CREDENTIALS_PREVIOUS_KEYS: each entry must be '
        + '"<version>:<base64 of 32 random bytes>"'
      ])
    })

    it.each([
      ['the version of the active key', keyOf(1)],
      ['the same version twice', `${keyOf(2)},${keyOf(2)}`]
    ])('rejects %s', (_case, previous) => {
      expect(
        problemsOf({ ...valid, CREDENTIALS_PREVIOUS_KEYS: previous })
      ).toEqual([
        'CREDENTIALS_PREVIOUS_KEYS: every key needs its own version number'
      ])
    })
  })

  describe('KK_SELLER_API_BASE_URL', () => {
    it('accepts the sandbox', () => {
      const url = 'https://seller-sandbox.kuantokusta.pt/api'

      expect(
        parseEnv({ ...valid, KK_SELLER_API_BASE_URL: url }).KK_SELLER_API_BASE_URL
      ).toBe(url)
    })

    it('accepts plain HTTP for a local fake, outside production only', () => {
      const local = { ...valid, KK_SELLER_API_BASE_URL: 'http://127.0.0.1:9/api' }

      expect(parseEnv({ ...local, NODE_ENV: 'test' }).KK_SELLER_API_BASE_URL)
        .toBe('http://127.0.0.1:9/api')
      expect(problemsOf({ ...local, NODE_ENV: 'production' })).toEqual([
        'KK_SELLER_API_BASE_URL: must use https',
        'KK_SELLER_API_BASE_URL: must be an address of kuantokusta.pt'
      ])
      // Leaving NODE_ENV out is the same as production.
      expect(problemsOf(local)).toHaveLength(2)
    })

    it.each([
      'https://seller.kuantokusta.pt.evil.example/api',
      'https://evil.example/api',
      'https://notkuantokusta.pt/api',
      'https://seller.kuantokusta.pt@evil.example/api'
    ])('in production, only sends the key to kuantokusta.pt, not %s', (url) => {
      const problems = problemsOf({
        ...valid,
        NODE_ENV: 'production',
        KK_SELLER_API_BASE_URL: url
      })

      expect(problems).toContain(
        'KK_SELLER_API_BASE_URL: must be an address of kuantokusta.pt'
      )
    })

    it.each([
      ['plain HTTP to a real host', 'http://seller.kuantokusta.pt/api', 'must use https'],
      ['another scheme', 'ftp://seller.kuantokusta.pt/api', 'must use https'],
      ['something that is not a URL', 'seller.kuantokusta.pt', 'must be a URL'],
      ['credentials in the URL', 'https://user:pw@seller.kuantokusta.pt/api', 'must not carry credentials or a query string'],
      ['a query string', 'https://seller.kuantokusta.pt/api?key=1', 'must not carry credentials or a query string']
    ])('rejects %s', (_case, url, rule) => {
      expect(
        problemsOf({
          ...valid,
          NODE_ENV: 'development',
          KK_SELLER_API_BASE_URL: url
        })
      ).toEqual([`KK_SELLER_API_BASE_URL: ${rule}`])
    })
  })

  describe('KK_SITE_BASE_URL', () => {
    it('accepts plain HTTP for a local fake, outside production only', () => {
      const local = { ...valid, KK_SITE_BASE_URL: 'http://127.0.0.1:9' }

      expect(parseEnv({ ...local, NODE_ENV: 'test' }).KK_SITE_BASE_URL)
        .toBe('http://127.0.0.1:9')
      expect(problemsOf({ ...local, NODE_ENV: 'production' })).toEqual([
        'KK_SITE_BASE_URL: must use https',
        'KK_SITE_BASE_URL: must be an address of kuantokusta.pt'
      ])
    })

    it.each([
      'https://www.kuantokusta.pt.evil.example',
      'https://evil.example',
      'https://user:secret@www.kuantokusta.pt',
      'https://www.kuantokusta.pt/?x=1',
      'not a url'
    ])('in production, only reads pages of kuantokusta.pt, not %s', (url) => {
      const problems = problemsOf({ ...valid, KK_SITE_BASE_URL: url })

      expect(problems.length).toBeGreaterThan(0)
      expect(
        problems.every((problem) => problem.startsWith('KK_SITE_BASE_URL: '))
      ).toBe(true)
      // The value is never echoed back.
      expect(problems.join(' ')).not.toContain('evil')
      expect(problems.join(' ')).not.toContain('secret')
    })
  })

  describe('KK_COLLECTOR_USER_AGENT', () => {
    it.each([
      'PharmaHubPriceReport/1.0',
      'PharmaHubPriceReport/1.0 (price report for partner stores)',
      'ZincoGroupHub/2.1 (+https://hub.example/about; contact@hub.example)'
    ])('accepts a name that says what it is: %s', (userAgent) => {
      expect(
        parseEnv({ ...valid, KK_COLLECTOR_USER_AGENT: userAgent })
          .KK_COLLECTOR_USER_AGENT
      ).toBe(userAgent)
    })

    it.each([
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Mozilla/5.0 (compatible; PharmaHub/1.0)',
      'PharmaHub/1.0 (like Chrome/120.0)',
      'PharmaHub/1.0 Safari/605.1.15',
      'PharmaHub/1.0 (Gecko)',
      'curl',
      '',
      'PharmaHub',
      'PharmaHub/1.0 (two\nlines)'
    ])('refuses a name that imitates a browser or says nothing: %j', (userAgent) => {
      expect(
        problemsOf({ ...valid, KK_COLLECTOR_USER_AGENT: userAgent })
      ).toEqual([
        'KK_COLLECTOR_USER_AGENT: must look like "Name/1.0 (who is reading '
        + 'and why)" and must not imitate a browser'
      ])
    })
  })

  describe('KK_COLLECTION_DAILY_AT', () => {
    it('is off unless set', () => {
      expect(parseEnv(valid).KK_COLLECTION_DAILY_AT).toBeUndefined()
    })

    it.each(['00:00', '06:30', '23:59'])('accepts %s', (time) => {
      expect(
        parseEnv({ ...valid, KK_COLLECTION_DAILY_AT: time })
          .KK_COLLECTION_DAILY_AT
      ).toBe(time)
    })

    it.each(['24:00', '6:30', '06:60', '0630', 'daily', ''])(
      'refuses %j',
      (time) => {
        expect(problemsOf({ ...valid, KK_COLLECTION_DAILY_AT: time })).toEqual([
          'KK_COLLECTION_DAILY_AT: must be a time such as 06:30'
        ])
      }
    )
  })
})
