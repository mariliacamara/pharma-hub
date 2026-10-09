/**
 * Minimal robots.txt reader: enough to decide whether this client may fetch a path and
 * how long it must wait between requests.
 *
 * The file comes from a third party, so patterns are matched with a small linear
 * algorithm instead of being compiled into regular expressions, which a hostile file
 * could turn into a denial of service.
 */

export interface RobotsRule {
  allow: boolean
  pattern: string
}

export interface RobotsGroup {
  agents: string[]
  rules: RobotsRule[]
  crawlDelaySeconds: number | null
}

/** A file with more lines than this is not read at all: see `robotsLineCount`. */
export const ROBOTS_MAX_LINES = 20_000
const MAX_PATTERN_LENGTH = 500
const LINE_BREAK = /\r\n|\r|\n/

/** How many lines the file has, to refuse one too long to be read whole. */
export function robotsLineCount(text: string): number {
  return text.split(LINE_BREAK).length
}

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | null = null
  let previousWasAgent = false

  for (const rawLine of text.split(LINE_BREAK).slice(0, ROBOTS_MAX_LINES)) {
    const line = rawLine.replace(/#.*/, '').trim()
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()

    if (key === 'user-agent') {
      // Consecutive User-agent lines share the rules that follow them.
      if (!current || !previousWasAgent) {
        current = { agents: [], rules: [], crawlDelaySeconds: null }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      previousWasAgent = true
      continue
    }
    previousWasAgent = false
    if (!current) continue

    if (key === 'disallow' && value) {
      // Cut to a bounded length. A shorter pattern forbids more, never
      // less, so cutting can only make the hub more careful.
      current.rules.push({ allow: false, pattern: value.slice(0, MAX_PATTERN_LENGTH) })
    } else if (key === 'allow' && value && value.length <= MAX_PATTERN_LENGTH) {
      // An over-long Allow is left out: it would permit, so it is not guessed.
      current.rules.push({ allow: true, pattern: value })
    } else if (key === 'crawl-delay') {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds
    }
  }
  return groups
}

/**
 * Whether `clientName` may fetch `path` (path plus query string).
 *
 * `clientName` is the product token of the User-Agent, the part before the slash. Only
 * that token is compared with the file's agent names, so a contact address in the
 * User-Agent cannot accidentally match a short name on a ban list.
 *
 * Within a group the longest matching pattern wins; on a tie, Allow wins. No matching
 * rule means allowed. Every group that applies must allow the path (see `groupsFor`).
 */
export function isPathAllowed(
  groups: readonly RobotsGroup[],
  clientName: string,
  path: string
): boolean {
  return groupsFor(groups, clientName).every((set) => allowedBy(set, path))
}

function allowedBy(groups: readonly RobotsGroup[], path: string): boolean {
  let best: RobotsRule | null = null
  for (const rule of groups.flatMap((group) => group.rules)) {
    if (!matches(rule.pattern, path)) continue
    const longer = !best || rule.pattern.length > best.pattern.length
    const tieWonByAllow = best && rule.pattern.length === best.pattern.length && rule.allow
    if (longer || tieWonByAllow) best = rule
  }
  return best ? best.allow : true
}

/** The largest Crawl-delay that applies to the client, or 0 when the file sets none. */
export function crawlDelaySeconds(groups: readonly RobotsGroup[], clientName: string): number {
  return Math.max(
    0,
    ...groupsFor(groups, clientName)
      .flat()
      .map((group) => group.crawlDelaySeconds ?? 0)
  )
}

/**
 * The sets of groups the client must obey.
 *
 * Groups that name the client exactly replace the wildcard groups, as the standard says.
 * A group whose agent name is only PART of the client's name (the file says "doc", the
 * client is "DocFetcher") may or may not be meant for it. The hub then obeys both that
 * group and the wildcard groups: whichever reading is right, it never reads a path
 * either of them forbids.
 */
function groupsFor(groups: readonly RobotsGroup[], clientName: string): RobotsGroup[][] {
  const name = clientName.trim().toLowerCase()
  const named = (agent: string) => agent !== '*' && agent !== ''
  const wildcard = groups.filter((group) => group.agents.includes('*'))

  const exact = groups.filter((group) => group.agents.includes(name))
  if (exact.length > 0) return [exact]

  const partial = groups.filter((group) =>
    group.agents.some((agent) => named(agent) && name.includes(agent))
  )
  return partial.length > 0 ? [partial, wildcard] : [wildcard]
}

/**
 * robots.txt matching: `*` stands for any run of characters, a trailing `$` anchors the
 * end, and without `$` the pattern only needs to match the beginning of the path.
 */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const glob = anchored ? pattern.slice(0, -1) : `${pattern}*`
  return globMatches(glob, path)
}

/** Wildcard match in O(pattern x text) worst case, with no exponential blow-up. */
function globMatches(glob: string, text: string): boolean {
  let g = 0
  let t = 0
  let starAt = -1
  let resumeAt = 0
  while (t < text.length) {
    if (g < glob.length && glob[g] === '*') {
      starAt = g++
      resumeAt = t
    } else if (g < glob.length && glob[g] === text[t]) {
      g++
      t++
    } else if (starAt !== -1) {
      g = starAt + 1
      t = ++resumeAt
    } else {
      return false
    }
  }
  while (g < glob.length && glob[g] === '*') g++
  return g === glob.length
}
