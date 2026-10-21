/**
 * Pure extraction helpers for the branch tree: turn text projection, title,
 * and subagent forest building. No DSH imports — unit-testable on plain event
 * arrays (see test/extract.test.mjs).
 */

/** How a turn's user/assistant text is clipped in the tree payload. */
export const MAX_USER_CHARS = 300
/** How a turn's assistant text is clipped in the tree payload. */
export const MAX_ASSISTANT_CHARS = 800
/** Title fallback clip length (matches DSH's own session title heuristic). */
const MAX_TITLE_CHARS = 42

/** The first user message of a freshly spawned session carries the runtime
 *  context snapshot; it is not a real user turn and must not become one. */
const RUNTIME_CONTEXT_PREFIX =
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'

function clip(text, max) {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

function blockText(blocks) {
  const parts = []
  const visit = (content) => {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (block.type === 'tool-result') visit(block.content)
    }
  }
  visit(blocks)
  return parts.join('\n').trim()
}

/**
 * Project a user message's `data.content` blocks (or an assistant message's
 * `data.message.content` blocks) to plain text. Tool calls/results are dropped:
 * the tree only ever shows user and assistant prose.
 */
export function contentText(content) {
  return blockText(content)
}

/** Whether a projected user text is the harness runtime-context preamble. */
export function isRuntimeContextText(text) {
  return typeof text === 'string' && text.trimStart().startsWith(RUNTIME_CONTEXT_PREFIX)
}


/**
 * Strip leading `<system-reminder>…</system-reminder>` blocks from a user
 * text. Subagent sessions receive their task inside such a wrapper; the
 * wrapper itself is plumbing, not a prompt/title.
 */
export function stripSystemPreamble(text) {
  let out = String(text).trimStart()
  for (;;) {
    const match = /^<system-reminder>[\s\S]*?<\/system-reminder>\s*/.exec(out)
    if (match === null) break
    out = out.slice(match[0].length)
  }
  return out.trim()
}

/**
 * Project one `user/message` event to real user prose, or '' when the event is
 * a harness injection rather than something the user typed.
 *
 * DSH delivers runtime context, plan-mode notices and similar injections as
 * user messages; their `data.source.kind` is not 'user' (e.g. 'time-context',
 * 'plan-mode', 'runtime-context'). Older logs may omit `source` — there the
 * known text preambles are the fallback discriminator.
 */
export function userMessageText(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'user/message') return ''
  const source = event.data?.source
  if (source !== null && typeof source === 'object' && typeof source.kind === 'string' && source.kind !== 'user') return ''
  const text = stripSystemPreamble(contentText(event.data?.content))
  if (text === '') return ''
  if (isRuntimeContextText(text)) return ''
  if (/^Time sampled while preparing turn\b/.test(text)) return ''
  return text
}

/**
 * Extract the newest completed round from a session's own events.
 *
 * A round is one user prompt plus the final assistant text of that turn: the
 * assistant may emit several messages per turn, so the *last* assistant text
 * before `turn/end` wins. Tool events never contribute text. Forks inherit
 * their parent's event log — callers must pass only the child-owned tail
 * (`session.inheritedEventCount` onward).
 *
 * @param {readonly Record<string, unknown>[]} events
 * @returns {{round: {user: string, assistant: string, turn: number|null, at: number|null, incomplete: boolean} | null}}
 */
export function extractLastRound(events) {
  if (!Array.isArray(events) || events.length === 0) return { round: null }

  let endIdx = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/end') {
      endIdx = i
      break
    }
  }

  // A prompt newer than the last completed turn is the running round: show it
  // as an in-flight card rather than falling back to the previous round.
  for (let i = events.length - 1; i > endIdx; i -= 1) {
    const text = userMessageText(events[i])
    if (text === '') continue
    return {
      round: {
        user: clip(text, MAX_USER_CHARS),
        assistant: '',
        turn: null,
        at: typeof events[i].time === 'number' ? events[i].time : null,
        incomplete: true,
      },
    }
  }

  if (endIdx === -1) return { round: null }

  let userText = ''
  let userIdx = -1
  for (let i = endIdx - 1; i >= 0; i -= 1) {
    const text = userMessageText(events[i])
    if (text !== '') {
      userText = text
      userIdx = i
      break
    }
  }

  let assistantText = ''
  for (let i = endIdx - 1; i > userIdx; i -= 1) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const text = contentText(event.data?.message?.content)
    if (text !== '') {
      assistantText = text
      break
    }
  }

  if (userText === '' && assistantText === '') return { round: null }

  const endEvent = events[endIdx]
  return {
    round: {
      user: clip(userText, MAX_USER_CHARS),
      assistant: clip(assistantText, MAX_ASSISTANT_CHARS),
      turn: typeof endEvent?.data?.turn === 'number' ? endEvent.data.turn : null,
      at: typeof endEvent?.time === 'number' ? endEvent.time : null,
      incomplete: false,
    },
  }
}

/**
 * Best-effort session title: the newest `session/title` event, else the first
 * real user prompt truncated, else the given fallback.
 *
 * @param {readonly Record<string, unknown>[]} events
 * @param {string} fallback
 */
export function extractTitle(events, fallback = '空白分支') {
  if (!Array.isArray(events)) return fallback
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim() !== '') {
      return event.data.title.trim()
    }
  }
  const limit = Math.min(events.length, 200)
  for (let i = 0; i < limit; i += 1) {
    const text = userMessageText(events[i])
    if (text !== '' && !text.trimStart().startsWith('<')) return clip(text.replace(/\s+/g, ' '), MAX_TITLE_CHARS)
  }
  return fallback
}

/**
 * Build a forest from a flat descendant list (stable pre-order input, as
 * `ctx.subagents.listDescendants` returns). Entries whose parent is outside
 * the list become forest roots — for a subagent query rooted at one main
 * node, those roots are that node's direct subagents.
 *
 * @param {readonly {id: string, parentId?: string|null}[]} entries
 * @param {string} rootId
 */
export function buildForest(entries, rootId) {
  const byId = new Map()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.id !== 'string' || entry.id === '') continue
    byId.set(entry.id, { ...entry, children: [] })
  }
  const roots = []
  for (const node of byId.values()) {
    const parentId = typeof node.parentId === 'string' ? node.parentId : null
    const parent = parentId !== null ? byId.get(parentId) : undefined
    if (parent !== undefined && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/**
 * Extract EVERY round from a session event log, in order.
 *
 * A round is one turn: the user's prompt plus the turn's final assistant text
 * (tool events never contribute text). `endSeq` is the event seq where the
 * round closes (the `turn/end`, or the last event for an in-flight round) —
 * fork attachment uses it to map a child session's inherited prefix back to
 * the round it branched from.
 *
 * @param {readonly Record<string, unknown>[]} events
 * @returns {{index: number, user: string, assistant: string, turn: number|null, at: number|null, endSeq: number, incomplete: boolean}[]}
 */
export function extractRounds(events) {
  const rounds = []
  if (!Array.isArray(events) || events.length === 0) return rounds

  let current = null
  let lastSeq = -1

  const close = (event) => {
    if (current === null) return
    const endSeq = typeof event?.seq === 'number' ? event.seq : current.lastSeq
    const at = typeof event?.time === 'number' ? event.time : current.at
    const turn = typeof event?.data?.turn === 'number' ? event.data.turn : current.turn
    if (current.user !== '' || current.assistant !== '') {
      rounds.push({
        index: rounds.length,
        user: clip(current.user, MAX_USER_CHARS),
        assistant: clip(current.assistant, MAX_ASSISTANT_CHARS),
        turn,
        at,
        userAt: current.userAt ?? null,
        userSeq: current.userSeq ?? null,
        endSeq,
        incomplete: false,
      })
    }
    current = null
  }

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const seq = typeof event.seq === 'number' ? event.seq : lastSeq + 1
    lastSeq = Math.max(lastSeq, seq)

    if (event.type === 'user/message') {
      const text = userMessageText(event)
      if (text !== '') {
        if (current === null) {
          current = {
            user: text,
            assistant: '',
            turn: null,
            at: typeof event.time === 'number' ? event.time : null,
            userAt: typeof event.time === 'number' ? event.time : null,
            userSeq: seq,
            lastSeq: seq,
          }
        } else if (current.user === '') {
          current.user = text
        }
      }
      continue
    }
    if (event.type === 'assistant/message') {
      if (current !== null) {
        const text = contentText(event.data?.message?.content)
        if (text !== '') current.assistant = text
      }
      continue
    }
    if (event.type === 'turn/end') {
      if (current !== null) {
        if (typeof event.data?.turn === 'number') current.turn = event.data.turn
        close(event)
      }
    }
  }

  if (current !== null) {
    rounds.push({
      index: rounds.length,
      user: clip(current.user, MAX_USER_CHARS),
      assistant: clip(current.assistant, MAX_ASSISTANT_CHARS),
      turn: current.turn,
      at: current.at,
      userAt: current.userAt ?? null,
      userSeq: current.userSeq ?? null,
      endSeq: lastSeq,
      incomplete: true,
    })
  }
  return rounds
}

/**
 * One-line, length-bounded title from prose. Used as the instant fallback while
 * a model title is pending, and as the final fallback when no model route is
 * available. The returned string never exceeds `maxChars` characters (the
 * ellipsis counts toward the budget).
 *
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function shortTitle(text, maxChars = 10) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  const value = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)、])\s+/gm, '')
    .replace(/[#>*_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const first = value.split(/[。！？!?；;\n]/)[0].trim() || value
  const chars = Array.from(first)
  if (chars.length <= maxChars) return first
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`
}
