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

const MAX_LINES = 5000
const MAX_PATTERN_LENGTH = 500

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | null = null
  let previousWasAgent = false

  for (const rawLine of text.split(/\r?\n/).slice(0, MAX_LINES)) {
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

    if ((key === 'allow' || key === 'disallow') && value && value.length <= MAX_PATTERN_LENGTH) {
      current.rules.push({ allow: key === 'allow', pattern: value })
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
 * The longest matching pattern wins; on a tie, Allow wins. No matching rule means allowed.
 */
export function isPathAllowed(
  groups: readonly RobotsGroup[],
  clientName: string,
  path: string
): boolean {
  let best: RobotsRule | null = null
  for (const rule of groupsFor(groups, clientName).flatMap((group) => group.rules)) {
    if (!matches(rule.pattern, path)) continue
    const longer = !best || rule.pattern.length > best.pattern.length
    const tieWonByAllow = best && rule.pattern.length === best.pattern.length && rule.allow
    if (longer || tieWonByAllow) best = rule
  }
  return best ? best.allow : true
}

/** The largest Crawl-delay that applies to the client, or 0 when the file sets none. */
export function crawlDelaySeconds(groups: readonly RobotsGroup[], clientName: string): number {
  return Math.max(0, ...groupsFor(groups, clientName).map((group) => group.crawlDelaySeconds ?? 0))
}

/** Groups naming this client specifically, or else the wildcard groups. */
function groupsFor(groups: readonly RobotsGroup[], clientName: string): RobotsGroup[] {
  const name = clientName.trim().toLowerCase()
  const specific = groups.filter((group) =>
    group.agents.some((agent) => agent !== '*' && agent !== '' && name.includes(agent))
  )
  return specific.length > 0 ? specific : groups.filter((group) => group.agents.includes('*'))
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
