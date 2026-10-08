import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { crawlDelaySeconds, isPathAllowed, parseRobots } from '#/kuantokusta/domain/robots'

const kuantokusta = parseRobots(
  readFileSync(new URL('../../../fixtures/robots-kuantokusta.txt', import.meta.url), 'utf8')
)
const CLIENT = 'PharmaHubPriceReport'

describe('robots.txt of KuantoKusta', () => {
  it.each([
    '/p/3524536/omron-medidor-de-tensao-arterial-digital-rs2',
    '/p/3604318/sudocrem-multi-expert-125g',
    '/robots.txt'
  ])('allows %s', (path) => {
    expect(isPathAllowed(kuantokusta, CLIENT, path)).toBe(true)
  })

  it.each([
    ['the site search', '/search?q=5601234567890'],
    ['the internal API', '/api/products/3524536'],
    ['price listings', '/precos/saude'],
    ['brand pages', '/marca/omron'],
    ['a product URL with a sort parameter', '/p/3524536/omron?sort=price'],
    ['a product URL with a price filter', '/p/3524536/omron?price=10-20'],
    ['a URL ending in a hyphen', '/p/1/termina-em-hifen-'],
    ['an ajax endpoint under any prefix', '/p/ajax/offers']
  ])('disallows %s', (_label, path) => {
    expect(isPathAllowed(kuantokusta, CLIENT, path)).toBe(false)
  })

  it('applies the ban list only to the clients it names', () => {
    expect(isPathAllowed(kuantokusta, 'SemrushBot', '/p/1/x')).toBe(false)
    expect(isPathAllowed(kuantokusta, CLIENT, '/p/1/x')).toBe(true)
  })

  it('uses the group written for a named client instead of the wildcard group', () => {
    expect(isPathAllowed(kuantokusta, 'AdsBot-Google', '/search?q=1')).toBe(true)
    expect(isPathAllowed(kuantokusta, 'AdsBot-Google', '/p/9/caes-bravecto-500mg')).toBe(false)
  })

  it('sets no crawl delay', () => {
    expect(crawlDelaySeconds(kuantokusta, CLIENT)).toBe(0)
  })
})

describe('robots.txt rules', () => {
  it('allows everything when the file is empty', () => {
    expect(isPathAllowed(parseRobots(''), CLIENT, '/anything')).toBe(true)
  })

  it('lets the longest matching pattern win, and Allow win a tie', () => {
    const groups = parseRobots(
      ['User-agent: *', 'Disallow: /p/', 'Allow: /p/public/', 'Disallow: /tie', 'Allow: /tie'].join(
        '\n'
      )
    )
    expect(isPathAllowed(groups, CLIENT, '/p/secret')).toBe(false)
    expect(isPathAllowed(groups, CLIENT, '/p/public/page')).toBe(true)
    expect(isPathAllowed(groups, CLIENT, '/tie')).toBe(true)
  })

  it('treats an empty Disallow as allowing everything', () => {
    expect(isPathAllowed(parseRobots('User-agent: *\nDisallow:'), CLIENT, '/x')).toBe(true)
  })

  it('anchors a pattern ending in $ to the end of the path', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /*.pdf$')
    expect(isPathAllowed(groups, CLIENT, '/files/report.pdf')).toBe(false)
    expect(isPathAllowed(groups, CLIENT, '/files/report.pdf?download=1')).toBe(true)
  })

  it('ignores comments and reads the crawl delay', () => {
    const groups = parseRobots(
      'User-agent: * # everyone\nCrawl-delay: 7 # seconds\nDisallow: /private # hidden'
    )
    expect(crawlDelaySeconds(groups, CLIENT)).toBe(7)
    expect(isPathAllowed(groups, CLIENT, '/private/x')).toBe(false)
  })

  it('matches agent names against the client name only', () => {
    const groups = parseRobots('User-agent: doc\nDisallow: /\n\nUser-agent: *\nDisallow:')
    // A contact address containing "doc" must not put the client on the ban list.
    expect(isPathAllowed(groups, CLIENT, '/p/1/x')).toBe(true)
    expect(isPathAllowed(groups, 'DocFetcher', '/p/1/x')).toBe(false)
  })

  it('stays fast on a pattern built to make a regular expression backtrack', () => {
    const hostile = `User-agent: *\nDisallow: /${'a*'.repeat(200)}b`
    const started = performance.now()
    expect(isPathAllowed(parseRobots(hostile), CLIENT, `/${'a'.repeat(5000)}`)).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
