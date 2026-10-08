import { describe, it, expect } from '@jest/globals'

import { EnvError, parseEnv } from '#/infra/config/env'

const valid = {
  DATABASE_URL: 'postgresql://app:secret@localhost:5432/pharma_hub'
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
      NODE_ENV: 'development',
      PORT: 7000,
      DATABASE_URL: valid.DATABASE_URL
    })
  })

  it('reads explicit values', () => {
    const env = parseEnv({ ...valid, PORT: '8080', NODE_ENV: 'production' })

    expect(env.PORT).toBe(8080)
    expect(env.NODE_ENV).toBe('production')
  })

  it('accepts the short postgres:// scheme', () => {
    const url = 'postgres://app:secret@localhost:5432/pharma_hub'

    expect(parseEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url)
  })

  it('reports every problem at once, naming the variables', () => {
    const problems = problemsOf({ PORT: 'abc', NODE_ENV: 'staging' })

    expect(problems).toHaveLength(3)
    expect(problems.map((problem) => problem.split(':')[0]).sort()).toEqual([
      'DATABASE_URL',
      'NODE_ENV',
      'PORT'
    ])
  })

  it('says that a missing DATABASE_URL is required', () => {
    expect(problemsOf({})).toEqual(['DATABASE_URL: is required'])
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
    const problems = problemsOf({ DATABASE_URL: secret })

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
})
