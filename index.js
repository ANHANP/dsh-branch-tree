/**
 * dsh-branch-tree — host half.
 *
 * Serves two read-only routes for the sidebar tab:
 *   GET /branch-tree/api/tree?sessionId=<id>  — the current session's branch
 *       family, as a round-level tree: every conversation round is a node, a
 *       session's rounds chain downward, and a forked session's first node
 *       hangs off the round it forked from.
 *   GET /branch-tree/ui/*                     — the iframe UI (read from disk on
 *       every request, so layout/CSS tweaks only need a refresh, not an app
 *       restart).
 *
 * Data sources (host-side, no HTTP fan-out):
 *   ctx.get('sessionQuery')  — durable session corpus: listSessions() includes
 *       sessions that are NOT live (branches you are not looking at),
 *       readSession(id) loads a cold log. Falls back to ctx.sessions (live store
 *       only) when absent. Cold logs are cached in this process (they cannot
 *       change while cold), so UI polling stays cheap.
 *   ctx.get('subagents').listDescendants(rootId) — catalog-only subagent tree;
 *       falls back to a header scan of origin=subagent sessions.
 *   Event projection (lib/extract.js): rounds are user/message → final
 *       assistant/message per turn/end; injected runtime context / plan-mode
 *       notices are filtered; tool calls never become text. Fork attachment uses
 *       the child's `inheritedEventCount` mapped onto the parent's round seqs.
 *
 * Security: the routes mirror the /api gateway's browser-trust fence (inlined
 * like dsh-video-preview so the plugin has no host-package dependency):
 * loopback Host header only, cross-site browser requests refused, GET only.
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildForest, extractRounds, extractTitle, shortTitle } from './lib/extract.js'

/** Plugin identity for cordis rows / client-modules keying. */
export const name = 'dsh-branch-tree'

/**
 * Host services required before mounting. `webRuntime` is optional: this host
 * does not provide it, so the route fence falls back to loopback-only.
 */
export const inject = ['webServer', 'sessions']

const MAX_SESSIONS = 40
const MAX_ROUNDS_PER_SESSION = 80
const MAX_SUBAGENT_NODES = 60
const READ_CONCURRENCY = 4

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh-beta')
/** Model-generated round titles are cached; only new rounds hit the model. */
const TITLE_CACHE_FILE = join(DSH_HOME, 'branch-tree', 'round-titles.json')
const DEBUG_FILE = join(DSH_HOME, 'branch-tree', 'debug.jsonl')
const TITLE_MAX_CHARS = 10
const TITLE_JOBS_PER_REQUEST = 6
const TITLE_GENERATE_CONCURRENCY = 2
const TITLE_TIMEOUT_MS = 15000

const TITLE_SYSTEM = [
  'You name one conversation round for a branching chat sidebar.',
  'Given the human message (and optionally the assistant reply), return ONLY a very short plain-text title.',
  'Rules: one line; same language as the user; at most 10 CJK characters or 6 words; a short noun/action phrase describing the round intent; no quotes, no markdown, no punctuation at the end, no explanation.',
].join(' ')

const ASSET_ROOT = new URL('./ui/', import.meta.url)
const ASSET_TYPES = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
}
const UI_ROUTE = '/branch-tree/ui'
const API_ROUTE = '/branch-tree/api/tree'

// ── browser-trust fence (same semantics as @deepseek-ai/dsh-client-connection's
//    /api gateway, inlined like dsh-video-preview) ───────────────────────────

function header(headers, field) {
  const value = headers[field]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── concurrency helper ──────────────────────────────────────────────────────
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

// ── session corpus ──────────────────────────────────────────────────────────

function parentIdOfHeader(header) {
  const parent = header?.parentSession
  return typeof parent === 'string' && parent !== '' ? parent : null
}

/**
 * A live-preferred, durable view over sessions. Cold persisted logs are parsed
 * once and cached: they cannot change until an agent attaches them.
 */
function createCorpus(ctx) {
  const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  const useQuery = query !== undefined && typeof query.listSessions === 'function' && typeof query.readSession === 'function'
  const coldCache = new Map()

  const listHeaders = async () => {
    if (useQuery) {
      try {
        const records = await query.listSessions()
        return records
          .map((record) => record?.header)
          .filter((value) => value !== null && typeof value === 'object' && typeof value.id === 'string')
      } catch {
        /* fall back to the live store below */
      }
    }
    return ctx.sessions
      .list()
      .map((session) => session?.header)
      .filter((value) => value !== null && typeof value === 'object' && typeof value.id === 'string')
  }

  /** Full logical log (in fork children this includes the inherited prefix). */
  const load = async (sessionId) => {
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) {
      const inherited = typeof live.inheritedEventCount === 'number' ? live.inheritedEventCount : 0
      let events = []
      try {
        events = live.snapshotEvents()
      } catch {
        events = []
      }
      return { header: live.header ?? null, inheritedEventCount: inherited, events }
    }
    const cached = coldCache.get(sessionId)
    if (cached !== undefined) return cached
    if (!useQuery) return null
    try {
      const loaded = await query.readSession(sessionId)
      if (loaded === null || typeof loaded !== 'object' || !Array.isArray(loaded.events)) return null
      const record = {
        header: loaded.session !== null && typeof loaded.session === 'object' ? loaded.session : null,
        inheritedEventCount: typeof loaded.inheritedEventCount === 'number' ? loaded.inheritedEventCount : 0,
        events: loaded.events,
      }
      coldCache.set(sessionId, record)
      return record
    } catch {
      return null
    }
  }

  return { listHeaders, load }
}

/** Trim a session's own rounds for display; keeps the newest ones. */
function sliceRounds(rounds) {
  if (rounds.length <= MAX_ROUNDS_PER_SESSION) return { rounds, truncated: false }
  return { rounds: rounds.slice(-MAX_ROUNDS_PER_SESSION), truncated: true }
}

// ── round titles: cache + cheap model generation ───────────────────────────

let titleCache = null
let titleCacheLoading = null
let titlePersistChain = Promise.resolve()
const titleInFlight = new Set()

function titleKey(sessionId, round) {
  return `${sessionId}|${round.endSeq}`
}

async function ensureTitleCache() {
  if (titleCache !== null) return titleCache
  if (titleCacheLoading === null) {
    titleCacheLoading = (async () => {
      const loaded = new Map()
      try {
        const raw = await readFile(TITLE_CACHE_FILE, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') {
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string' && value.trim() !== '') loaded.set(key, value)
          }
        }
      } catch {
        /* first run: no cache yet */
      }
      titleCache = loaded
      return loaded
    })()
  }
  return titleCacheLoading
}

function persistTitleCache() {
  titlePersistChain = titlePersistChain
    .then(async () => {
      const entries = [...titleCache.entries()].slice(-4000)
      titleCache = new Map(entries)
      await mkdir(dirname(TITLE_CACHE_FILE), { recursive: true })
      const temporary = `${TITLE_CACHE_FILE}.tmp`
      await writeFile(temporary, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf8')
      await rename(temporary, TITLE_CACHE_FILE)
    })
    .catch(() => {})
  return titlePersistChain
}

/** Latest model route seen in a session log (same route DSH uses for titles). */
export function detectTitleRoute(events) {
  let route = null
  for (const event of events ?? []) {
    if (event === null || typeof event !== 'object') continue
    const candidate =
      event.type === 'session/title-llm-request'
        ? event.data?.route
        : event.type === 'request/header'
          ? event.data?.header?.config
          : undefined
    if (candidate === null || typeof candidate !== 'object') continue
    if (typeof candidate.provider !== 'string' || typeof candidate.model !== 'string') continue
    route = { provider: candidate.provider, model: candidate.model }
  }
  return route
}

/** Clean one model answer into a bounded plain-text title. */
export function normalizeGeneratedTitle(text, maxChars = TITLE_MAX_CHARS) {
  if (typeof text !== 'string') return ''
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '') ?? ''
  const cleaned = line
    .replace(/[。.！!？?；;：:]+$/, '')
    .replace(/^[`"'“”'‘’#>*_\-\s]+/, '')
    .replace(/[`"'“”'‘’*_\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(cleaned)
  if (chars.length === 0) return ''
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join('')}…` : cleaned
}

function buildTitleInput(job) {
  const user = String(job.round.user ?? '').slice(0, 600)
  const assistant = String(job.round.assistant ?? '').slice(0, 320)
  return `用户消息：\n${user}\n\n助手回复（节选）：\n${assistant}`
}

/** One cheap title call through the host LLM service. */
async function requestModelTitle(llm, route, job) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
  try {
    const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: 64 }, controller.signal)
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: buildTitleInput(job) }],
      source: { kind: 'user' },
    }
    let text = ''
    let failure = null
    for await (const chunk of call.stream({
      ...call.config,
      messages: [message],
      system: TITLE_SYSTEM,
      sessionId: job.sessionId,
      purpose: 'session-title',
      signal: controller.signal,
    })) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason !== undefined && chunk.reason.kind !== 'stop') failure = chunk.reason
    }
    if (failure !== null) throw new Error(`title model finished with ${failure.kind}${failure.failure?.message ? `: ${failure.failure.message}` : ''}`)
    return normalizeGeneratedTitle(text)
  } finally {
    clearTimeout(timer)
  }
}

async function generateMissingTitles(ctx, llm, route, jobs) {
  try {
    await mapLimit(jobs, TITLE_GENERATE_CONCURRENCY, async (job) => {
      try {
        const title = await requestModelTitle(llm, route, job)
        if (title !== '') titleCache.set(job.key, title)
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-branch-tree] title generation failed for ${job.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        titleInFlight.delete(job.key)
      }
    })
    if (jobs.length > 0) await persistTitleCache()
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-branch-tree] title batch failed: ${error instanceof Error ? error.message : String(error)}`)
    for (const job of jobs) titleInFlight.delete(job.key)
  }
}

function scheduleTitleGeneration(ctx, route, jobs) {
  if (route === null || jobs.length === 0) return
  let llm
  try {
    llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  } catch {
    llm = undefined
  }
  if (llm === undefined || typeof llm.prepareCall !== 'function') return
  const batch = jobs.filter((job) => !titleInFlight.has(job.key)).slice(0, TITLE_JOBS_PER_REQUEST)
  if (batch.length === 0) return
  for (const job of batch) titleInFlight.add(job.key)
  void generateMissingTitles(ctx, llm, route, batch)
}

/**
 * The current session's branch family, round by round: climb parentSession to
 * the highest durable ancestor, then walk every descendant session in BFS order
 * (parents before children, so `attachTo` can be resolved in one pass).
 */
async function buildFamily(ctx, currentId) {
  const corpus = createCorpus(ctx)
  const headers = await corpus.listHeaders()
  const byId = new Map()
  for (const header of headers) {
    if (header.origin === 'subagent') continue
    byId.set(header.id, header)
  }
  const current = byId.get(currentId)
  if (current === undefined) return { sessions: [], rootId: currentId, truncated: false, corpus, headers }

  let root = current
  const seen = new Set([root.id])
  for (;;) {
    const parentId = parentIdOfHeader(root)
    if (parentId === null || !byId.has(parentId) || seen.has(parentId)) break
    seen.add(parentId)
    root = byId.get(parentId)
  }

  const childrenOf = new Map()
  for (const header of byId.values()) {
    const parentId = parentIdOfHeader(header)
    if (parentId === null || !byId.has(parentId)) continue
    const list = childrenOf.get(parentId)
    if (list === undefined) childrenOf.set(parentId, [header])
    else list.push(header)
  }

  const order = []
  const queue = [{ header: root, depth: 0 }]
  let truncated = false
  while (queue.length > 0) {
    if (order.length >= MAX_SESSIONS) {
      truncated = true
      break
    }
    const { header, depth } = queue.shift()
    order.push({ header, depth })
    for (const child of childrenOf.get(header.id) ?? []) queue.push({ header: child, depth: depth + 1 })
  }

  const sessions = await mapLimit(order, READ_CONCURRENCY, async ({ header, depth }) => {
    const loaded = await corpus.load(header.id)
    const events = loaded?.events ?? []
    const inherited = loaded?.inheritedEventCount ?? 0
    const allRounds = extractRounds(events)
    const ownRounds = inherited > 0 ? allRounds.filter((round) => round.endSeq >= inherited) : allRounds
    const { rounds, truncated: roundsTruncated } = sliceRounds(ownRounds)
    const title = extractTitle(events, '空白分支')
    return {
      id: header.id,
      parentId: parentIdOfHeader(header),
      route: detectTitleRoute(events),
      depth,
      title,
      current: header.id === currentId,
      inheritedEventCount: inherited,
      rounds: rounds.map((round) => ({
        index: round.index,
        user: round.user,
        assistant: round.assistant,
        turn: round.turn,
        at: round.at,
        userAt: round.userAt,
        userSeq: round.userSeq,
        endSeq: round.endSeq,
        incomplete: round.incomplete,
      })),
      attachTo: null,
      subagentGroups: [],
      truncated: roundsTruncated,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
    }
  })

  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  for (const session of sessions) {
    if (session.id === root.id) continue
    const parent = session.parentId !== null ? sessionById.get(session.parentId) : undefined
    if (parent === undefined) continue
    const boundary = session.inheritedEventCount - 1
    if (parent.attachTo !== null && boundary < parent.inheritedEventCount) {
      session.attachTo = parent.attachTo
      continue
    }
    let attachIndex = null
    for (let i = parent.rounds.length - 1; i >= 0; i -= 1) {
      if (parent.rounds[i].endSeq <= boundary) {
        attachIndex = parent.rounds[i].index
        break
      }
    }
    if (attachIndex === null && parent.rounds.length > 0) attachIndex = parent.rounds[0].index
    session.attachTo = { sessionId: parent.id, roundIndex: attachIndex }
  }

  const route = sessions.find((session) => session.route !== null)?.route ?? null
  return { sessions, rootId: root.id, truncated, corpus, headers, route }
}

// ── subagents ───────────────────────────────────────────────────────────────

/** Fallback subagent enumeration from the durable header corpus. */
function scanSubagentHeaders(headers, rootSessionId) {
  const info = new Map()
  for (const header of headers) {
    if (header.origin !== 'subagent') continue
    info.set(header.id, { header, parentId: parentIdOfHeader(header) })
  }
  const entries = []
  const queue = []
  for (const entry of info.values()) {
    if (entry.parentId === rootSessionId) queue.push({ header: entry.header, parentId: rootSessionId, depth: 1 })
  }
  const seen = new Set()
  while (queue.length > 0) {
    const { header, parentId, depth } = queue.shift()
    if (seen.has(header.id)) continue
    seen.add(header.id)
    const children = [...info.values()].filter((candidate) => candidate.parentId === header.id)
    entries.push({
      kind: 'child',
      id: header.id,
      parentId,
      depth,
      hasChildren: children.length > 0,
      activity: 'inactive',
      mode: 'one-shot',
    })
    for (const child of children) queue.push({ header: child.header, parentId: header.id, depth: depth + 1 })
  }
  return entries
}

/** Prefer the subagent runtime catalog; fall back to the header scan. */
async function listSubagentEntries(ctx, headers, rootSessionId) {
  const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
  if (subagents !== undefined && typeof subagents.listDescendants === 'function') {
    try {
      const entries = await subagents.listDescendants(rootSessionId)
      if (Array.isArray(entries)) return entries
    } catch {
      /* catalog unavailable for this root: fall through */
    }
  }
  return scanSubagentHeaders(headers, rootSessionId)
}

/** Hydrate a raw descendant forest with title/last round/createdAt. */
async function hydrateSubagentForest(ctx, corpus, roots, budget) {
  const flat = []
  const walk = (node, depth) => {
    if (budget.count >= MAX_SUBAGENT_NODES) {
      budget.truncated = true
      return null
    }
    budget.count += 1
    const hydrated = {
      id: node.id,
      parentId: typeof node.parentId === 'string' ? node.parentId : null,
      depth,
      title: typeof node.label === 'string' && node.label !== '' ? node.label : '子代理',
      round: null,
      empty: true,
      createdAt: null,
      activity: node.activity === 'running' ? 'running' : 'inactive',
      mode: node.mode === 'continuable' ? 'continuable' : 'one-shot',
      diagnostic: node.diagnostic === true,
      children: [],
    }
    flat.push(hydrated)
    for (const child of node.children ?? []) {
      const childNode = walk(child, depth + 1)
      if (childNode !== null) hydrated.children.push(childNode)
    }
    return hydrated
  }
  const forest = []
  for (const root of roots) {
    const node = walk(root, 1)
    if (node !== null) forest.push(node)
  }
  await mapLimit(flat, READ_CONCURRENCY, async (node) => {
    const loaded = await corpus.load(node.id)
    if (loaded === null) return
    const title = extractTitle(loaded.events, node.title)
    if (title !== '空白分支') node.title = title
    const inherited = loaded.inheritedEventCount ?? 0
    const rounds = extractRounds(loaded.events)
    const own = inherited > 0 ? rounds.filter((round) => round.endSeq >= inherited) : rounds
    const last = own.at(-1) ?? null
    node.round = last === null ? null : {
      index: last.index,
      user: last.user,
      assistant: last.assistant,
      turn: last.turn,
      at: last.at,
      endSeq: last.endSeq,
      incomplete: last.incomplete,
    }
    node.empty = last === null
    node.createdAt = typeof loaded.header?.createdAt === 'number' ? loaded.header.createdAt : null
  })
  return forest
}

/** Bucket each root subagent by the round whose window contains its creation. */
function groupSubagentsByRound(rounds, forest) {
  const groups = new Map()
  for (const root of forest) {
    const at = typeof root.createdAt === 'number' ? root.createdAt : null
    let roundIndex = null
    if (rounds.length > 0) {
      roundIndex = rounds[0].index
      if (at !== null) {
        for (const round of rounds) {
          // Use the round's START (user prompt), not its completion time:
          // subagents hired during a turn are created after that turn's prompt
          // but before its final answer, so completion time would misplace them
          // one round earlier.
          const start = typeof round.userAt === 'number' ? round.userAt : round.at
          if (typeof start !== 'number') continue
          if (start <= at) roundIndex = round.index
        }
      }
    }
    const key = roundIndex === null ? 'null' : String(roundIndex)
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [root])
    else list.push(root)
  }
  return [...groups.entries()].map(([key, nodes]) => ({
    roundIndex: key === 'null' ? null : Number(key),
    forest: nodes,
  }))
}

// ── tree payload ────────────────────────────────────────────────────────────

async function buildTreePayload(ctx, currentId) {
  const family = await buildFamily(ctx, currentId)
  const budget = { count: 0, truncated: false }
  await mapLimit(family.sessions, 3, async (session) => {
    const entries = await listSubagentEntries(ctx, family.headers ?? [], session.id)
    const raw = []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue
      raw.push({
        id: entry.id,
        parentId: typeof entry.parentId === 'string' ? entry.parentId : null,
        label: typeof entry.label === 'string' ? entry.label : undefined,
        activity: entry.kind === 'child' ? entry.activity : 'inactive',
        mode: entry.mode,
        depth: entry.depth,
        diagnostic: entry.kind === 'diagnostic',
      })
    }
    const forest = await hydrateSubagentForest(ctx, family.corpus, buildForest(raw, session.id), budget)
    session.subagentGroups = groupSubagentsByRound(session.rounds, forest)
  })
  const cache = await ensureTitleCache()
  const jobs = []
  const sessions = family.sessions.map((session) => {
    const rounds = session.rounds.map((round) => {
      const key = titleKey(session.id, round)
      const cached = cache.get(key)
      const title = (cached ?? shortTitle(round.user || round.assistant, TITLE_MAX_CHARS)) || '（空轮次）'
      if (cached === undefined && round.incomplete !== true) {
        jobs.push({ key, sessionId: session.id, round })
      }
      return { ...round, title }
    })
    return {
      id: session.id,
      parentId: session.parentId,
      depth: session.depth,
      title: session.title,
      current: session.current,
      inheritedEventCount: session.inheritedEventCount,
      rounds,
      attachTo: session.attachTo,
      subagentGroups: session.subagentGroups,
      truncated: session.truncated,
    }
  })

  // Fire-and-forget: the tree renders immediately with heuristic titles and the
  // model titles land on the next poll (cached to disk for later runs).
  scheduleTitleGeneration(ctx, family.route, jobs)

  return {
    current: currentId,
    rootId: family.rootId,
    truncated: family.truncated || budget.truncated,
    sessions,
  }
}

// ── HTTP handlers ───────────────────────────────────────────────────────────

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function handleTree(ctx, req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (sessionId === '') {
    sendJson(res, 400, { ok: false, error: 'sessionId is required' })
    return
  }
  try {
    res.setHeader('cache-control', 'no-store')
    sendJson(res, 200, await buildTreePayload(ctx, sessionId))
  } catch (error) {
    ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function handleDebug(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  const chunks = []
  let size = 0
  let tooLarge = false
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) {
      tooLarge = true
      break
    }
    chunks.push(chunk)
  }
  if (tooLarge) {
    sendJson(res, 413, { ok: false, error: 'payload-too-large' })
    return
  }
  try {
    await mkdir(dirname(DEBUG_FILE), { recursive: true })
    const line = Buffer.concat(chunks).toString('utf8').trim()
    const record = JSON.stringify({ at: new Date().toISOString(), body: line === '' ? null : JSON.parse(line) })
    await appendFile(DEBUG_FILE, `${record}\n`, 'utf8')
    sendJson(res, 200, { ok: true })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function handleUi(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const suffix = url.pathname.slice(UI_ROUTE.length)
  const file = suffix === '' || suffix === '/' ? 'index.html' : suffix.replace(/^\//, '')
  const type = ASSET_TYPES[file]
  if (type === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  try {
    const body = await readFile(new URL(file, ASSET_ROOT))
    res.writeHead(200, { 'content-type': type, 'content-length': String(body.length), 'cache-control': 'no-store' })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}

/** Mount the host routes. */
export function apply(ctx) {
  // Optional: newer hosts expose webRuntime.trustedHosts; without it the fence
  // still accepts loopback authorities (the desktop web server binds loopback).
  const runtime = typeof ctx.get === 'function' ? ctx.get('webRuntime') : undefined
  const trustedHosts = Array.isArray(runtime?.trustedHosts) ? runtime.trustedHosts : []
  const fence = (req) => isTrustedRequest(req, trustedHosts)

  const route = (kind, path, handler) => {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind,
          path,
          handler: async (req, res) => {
            if (!fence(req)) {
              res.writeHead(403)
              res.end('forbidden')
              return
            }
            await handler(req, res)
          },
        }),
      `dsh-branch-tree: ${path}`,
    )
  }

  route('exact', API_ROUTE, (req, res) => handleTree(ctx, req, res))
  // Diagnostics are opt-in for development; a normal install never writes them.
  if (process.env.DSH_BRANCH_TREE_DEBUG === '1') {
    route('exact', '/branch-tree/api/debug', (req, res) => handleDebug(req, res))
  }
  route('prefix', UI_ROUTE, (req, res) => handleUi(req, res))
}

export { buildTreePayload }
