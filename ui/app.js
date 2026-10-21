/**
 * dsh-branch-tree — iframe UI (plain DOM/SVG, no framework).
 *
 * Data: GET /branch-tree/api/tree?sessionId=… returns the current session's
 * branch family as sessions + rounds. This UI turns it into a round-level tree:
 *
 *   - every conversation round (one user prompt + that turn's final assistant
 *     text) is one box; a session's rounds chain downward;
 *   - a forked session hangs off the exact round it forked from (host sends
 *     `attachTo`, resolved from the child's inherited event count);
 *   - subagent forests attach to the round whose time window contains the
 *     subagent's creation, to the right of that box.
 *
 * Click a round box → open its session in the main conversation view.
 * Hold & drag to pan; trackpad pinch (ctrl+wheel) or two-finger touch pinch to
 * zoom. Theme is read from the parent DSH document (same-origin) and observed.
 */
'use strict'

// ── geometry ────────────────────────────────────────────────────────────────
const NODE_W = 190
const NODE_H = 112
const GAP_X = 16
const ROW_GAP = 56
const SUB_W = 164
const SUB_H = 96
const SUB_GAP_Y = 20
const SUB_COL_GAP = 36
const PAD = 18
const COMPOSER_W = 320
const COMPOSER_H = 252
const MIN_ZOOM = 0.35
const MAX_ZOOM = 2.6
const POLL_MS = 4000

// ── camera persistence (pan/zoom survives session switches and tab reopens) ─
const CAMERA_KEY = 'dsh-branch-tree:camera:v1'

function readCamera() {
  try {
    const raw = localStorage.getItem(CAMERA_KEY)
    if (raw === null) return null
    const camera = JSON.parse(raw)
    if (camera === null || typeof camera !== 'object' || typeof camera.zoom !== 'number') return null
    return {
      zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom)),
      panX: typeof camera.panX === 'number' ? camera.panX : -Number(camera.left ?? 0),
      panY: typeof camera.panY === 'number' ? camera.panY : -Number(camera.top ?? 0),
    }
  } catch {
    return null
  }
}

function viewportVisible() {
  return els.viewport !== undefined && els.viewport.clientWidth > 0 && els.viewport.clientHeight > 0
}

function saveCamera() {
  // A freshly mounted iframe is still at (0,0) with no tree; writing that would
  // clobber the stored camera before the restore reads it. A HIDDEN tab
  // (display:none while the sidebar switches sessions) also reports scroll 0,
  // so it must never be the recorded camera either.
  if (state.data === null || !viewportVisible()) return
  const camera = { zoom: state.zoom, panX: state.panX, panY: state.panY }
  try {
    localStorage.setItem(CAMERA_KEY, JSON.stringify(camera))
  } catch {
    /* private mode: keep the camera in memory only */
  }
  try {
    window.parent.postMessage({ source: 'dsh-branch-tree', type: 'camera', camera }, location.origin)
  } catch {
    /* cross-origin parent: localStorage is the only channel */
  }
}

/** Fold a camera payload from the parent page into the current viewport. */
function acceptCamera(camera) {
  if (camera === null || typeof camera !== 'object' || typeof camera.zoom !== 'number') return
  state.pendingCamera = {
    zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom)),
    panX: typeof camera.panX === 'number' ? camera.panX : -Number(camera.left ?? 0),
    panY: typeof camera.panY === 'number' ? camera.panY : -Number(camera.top ?? 0),
  }
  if (state.data !== null) applyPendingCamera()
}

// ── branch composer (new "追问" branch from a round) ────────────────────────
const CUSTOM_CHIPS_KEY = 'dsh-branch-tree:custom-chips:v1'
const DEFAULT_CHIPS = ['展开说明', '举例', '通俗易懂', '对比解释']

function loadCustomChips() {
  try {
    const raw = localStorage.getItem(CUSTOM_CHIPS_KEY)
    const list = raw === null ? [] : JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, 6)
  } catch {
    return []
  }
}

function saveCustomChips() {
  try {
    localStorage.setItem(CUSTOM_CHIPS_KEY, JSON.stringify(state.customChips))
  } catch {
    /* storage is best-effort */
  }
}

// ── state ───────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search)
const state = {
  sessionId: params.get('session') ?? '',
  theme: 'light',
  data: null,
  dataJson: '',
  loading: false,
  error: null,
  collapsed: new Set(), // node keys whose descendants are folded
  subCollapsed: new Set(), // subagent ids whose children are folded
  subExpanded: new Set(), // node keys whose subagent forest is open
  firstRender: readCamera() === null,
  camera: readCamera(),
  pendingCamera: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  baseW: 0,
  baseH: 0,
  offsetX: PAD,
  offsetY: PAD,
  suppressClick: false,
  branchNames: {},
  editingBranch: null,
  pendingReveal: null,
  composer: null,
  composerFocus: false,
  minimapData: null,
  railMirrored: true,
  customChips: loadCustomChips(),
}

// ── DOM ─────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
const els = {
  viewport: $('viewport'),
  stage: $('stage'),
  canvas: $('canvas'),
  nodes: $('nodes'),
  edges: $('edges'),
  count: $('count'),
  loading: $('loading'),
  error: $('error'),
  errorText: $('error-text'),
  empty: $('empty'),
  emptyText: $('empty-text'),
  hint: $('hint'),
  refresh: $('refresh'),
  reload: $('reload'),
  retry: $('retry'),
  zoomIn: $('zoom-in'),
  zoomOut: $('zoom-out'),
  zoomReset: $('zoom-reset'),
  zoomLabel: $('zoom-label'),
  version: $('version'),
  minimap: $('minimap'),
  railToggle: $('rail-toggle'),
}

// ── round / branch titles ──────────────────────────────────────────────────
const BRANCH_NAMES_KEY = 'dsh-branch-tree:branch-names:v1'

function loadBranchNames() {
  try {
    const raw = localStorage.getItem(BRANCH_NAMES_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveBranchName(sessionId, name) {
  const trimmed = String(name).replace(/\s+/g, ' ').trim()
  if (trimmed === '') delete state.branchNames[sessionId]
  else state.branchNames[sessionId] = trimmed.slice(0, 60)
  try {
    localStorage.setItem(BRANCH_NAMES_KEY, JSON.stringify(state.branchNames))
  } catch {
    /* private mode etc. — names stay in memory for this session */
  }
}

/** Very short one-line title from a round's user/assistant prose. */
function shortTitle(text, maxChars = 10) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  let value = text
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

function roundTitle(round) {
  // The host fills model-generated titles into the payload; the heuristic only
  // covers the first paint (before generation lands) and missing rounds.
  if (typeof round?.title === 'string' && round.title.trim() !== '') return round.title
  const title = shortTitle(round?.user ?? '')
  if (title !== '') return title
  const fallback = shortTitle(round?.assistant ?? '')
  return fallback === '' ? '（空轮次）' : fallback
}

function branchInfo(session) {
  const custom = state.branchNames[session.id]
  if (typeof custom === 'string' && custom.trim() !== '') return { name: custom, custom: true }
  const auto = shortTitle(session.title ?? '', 10)
  if (auto !== '') return { name: auto, custom: false }
  const first = Array.isArray(session.rounds) && session.rounds.length > 0 ? roundTitle(session.rounds[0]) : ''
  return { name: first !== '' ? first : '空白分支', custom: false }
}

// ── theme (read the same-origin parent document) ───────────────────────────
function parentDocument() {
  try {
    if (window.parent !== null && window.parent !== window) return window.parent.document
  } catch {
    /* cross-origin parent (should not happen) */
  }
  return document
}

function detectTheme() {
  try {
    const doc = parentDocument()
    const root = doc.documentElement
    const body = doc.body
    if (body !== null && body.hasAttribute('data-ds-dark-theme')) return 'dark'
    const source = root !== null ? root.getAttribute('data-ds-theme-source') : null
    if (source === 'dark' || source === 'light') return source
    const scheme = String(
      (root !== null ? root.style.colorScheme : '') ||
        (root !== null ? getComputedStyle(root).colorScheme : '') ||
        '',
    ).toLowerCase()
    if (scheme.includes('dark')) return 'dark'
    if (scheme.includes('light')) return 'light'
    const sample = body !== null ? body : root
    const color = sample !== null ? getComputedStyle(sample).backgroundColor : ''
    const match = /rgba?\(([^)]+)\)/.exec(color)
    if (match !== null) {
      const parts = match[1].split(',').map(Number)
      if (parts.length >= 4 && parts[3] === 0) return 'light'
      if (parts.length >= 3) {
        const luminance = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255
        return luminance < 0.5 ? 'dark' : 'light'
      }
    }
  } catch {
    /* fall through */
  }
  const queryTheme = params.get('theme')
  if (queryTheme === 'dark' || queryTheme === 'light') return queryTheme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme() {
  const theme = detectTheme()
  if (theme === state.theme) return
  state.theme = theme
  document.body.className = `theme-${theme}`
}

function observeTheme() {
  const initial = detectTheme()
  state.theme = initial
  document.body.className = `theme-${initial}`
  try {
    const doc = parentDocument()
    const observer = new MutationObserver(() => applyTheme())
    if (doc.documentElement !== null) observer.observe(doc.documentElement, { attributes: true })
    if (doc.body !== null) observer.observe(doc.body, { attributes: true })
    return () => observer.disconnect()
  } catch {
    return () => {}
  }
}

// ── graph construction (sessions + rounds → single tree) ───────────────────
function roundKey(sessionId, roundIndex) {
  return `r:${sessionId}:${roundIndex}`
}
function blankKey(sessionId) {
  return `b:${sessionId}`
}
function firstNodeKey(session) {
  return session.rounds.length > 0 ? roundKey(session.id, session.rounds[0].index) : blankKey(session.id)
}
function lastNodeKey(session) {
  return session.rounds.length > 0 ? roundKey(session.id, session.rounds[session.rounds.length - 1].index) : blankKey(session.id)
}

function buildGraph(sessions) {
  const nodes = new Map()
  const list = Array.isArray(sessions) ? sessions : []

  // 1) one node per round (or one blank node per empty session)
  for (const session of list) {
    if (!Array.isArray(session.rounds) || session.rounds.length === 0) {
      nodes.set(blankKey(session.id), {
        key: blankKey(session.id),
        kind: 'blank',
        session,
        ordinal: 0,
        children: [],
        groups: [],
      })
      continue
    }
    session.rounds.forEach((round, ordinal) => {
      nodes.set(roundKey(session.id, round.index), {
        key: roundKey(session.id, round.index),
        kind: 'round',
        session,
        round,
        ordinal,
        children: [],
        groups: [],
      })
    })
    // 2) chain a session's rounds vertically
    for (let i = 0; i < session.rounds.length - 1; i += 1) {
      const from = nodes.get(roundKey(session.id, session.rounds[i].index))
      const to = nodes.get(roundKey(session.id, session.rounds[i + 1].index))
      if (from !== undefined && to !== undefined) from.children.push({ key: to.key, kind: 'chain' })
    }
  }

  // 3) attach each fork at the round it inherited through
  for (const session of list) {
    if (session.attachTo === null || session.attachTo === undefined) continue
    const attach = session.attachTo
    const target =
      attach.roundIndex === null || attach.roundIndex === undefined
        ? nodes.get(blankKey(attach.sessionId))
        : nodes.get(roundKey(attach.sessionId, attach.roundIndex))
    const own = nodes.get(firstNodeKey(session))
    if (target === undefined || own === undefined) continue
    if (!target.children.some((child) => child.key === own.key)) target.children.push({ key: own.key, kind: 'branch' })
  }

  // 4) subagent groups live on the round that spawned them
  for (const session of list) {
    for (const group of session.subagentGroups ?? []) {
      const target =
        group.roundIndex === null || group.roundIndex === undefined
          ? nodes.get(blankKey(session.id))
          : nodes.get(roundKey(session.id, group.roundIndex))
      if (target !== undefined && Array.isArray(group.forest) && group.forest.length > 0) target.groups.push(group)
    }
  }

  // 5) depth from the root (fall back to the first attachable node)
  const roots = list
    .filter((session) => session.attachTo === null || session.attachTo === undefined)
    .map((session) => firstNodeKey(session))
  const depth = new Map()
  const visit = (key, value) => {
    if (depth.has(key)) return
    const node = nodes.get(key)
    if (node === undefined) return
    depth.set(key, value)
    for (const child of node.children) visit(child.key, value + 1)
  }
  const rootKey = roots.find((key) => nodes.has(key)) ?? [...nodes.keys()][0]
  if (rootKey !== undefined) visit(rootKey, 0)

  return { nodes, rootKey, depth }
}

function visibleNodes(graph) {
  if (graph.rootKey === undefined) return new Map()
  const visible = new Map()
  const walk = (key) => {
    const node = graph.nodes.get(key)
    if (node === undefined || visible.has(key)) return
    visible.set(key, node)
    if (state.collapsed.has(key)) return
    for (const child of node.children) walk(child.key)
  }
  walk(graph.rootKey)
  return visible
}

// ── layout: vertical round tree + right-side subagent forests ──────────────
function layoutMain(graph) {
  const visible = visibleNodes(graph)
  const positions = new Map()
  const edges = []
  if (visible.size === 0) return { positions, edges, visibleCount: 0, visible }

  let cursor = 0
  const walk = (key) => {
    const node = visible.get(key)
    if (node === undefined) return null
    const y = graph.depth.get(key) * (NODE_H + ROW_GAP)
    const kids = node.children.map((child) => child).filter((child) => visible.has(child.key))
    let left
    if (kids.length === 0) {
      left = cursor * (NODE_W + GAP_X)
      cursor += 1
    } else {
      const spans = kids.map((child) => walk(child.key)).filter(Boolean)
      left = spans.length === 0 ? cursor++ * (NODE_W + GAP_X) : (spans[0].left + spans[spans.length - 1].right) / 2 - NODE_W / 2
    }
    positions.set(key, { x: left, y, w: NODE_W, h: NODE_H, node })
    for (const child of kids) {
      const childPos = positions.get(child.key)
      if (childPos === undefined) continue
      edges.push({
        from: { x: left + NODE_W / 2, y: y + NODE_H },
        to: { x: childPos.x + NODE_W / 2, y: childPos.y },
        kind: child.kind,
        fromKey: key,
        toKey: child.key,
      })
    }
    return { left, right: left + NODE_W }
  }
  walk(graph.rootKey)
  return { positions, edges, visibleCount: positions.size, visible }
}

function layoutSubagents(mainPositions) {
  const positions = new Map()
  const edges = []
  for (const [key, mainPos] of mainPositions) {
    const node = mainPos.node
    if (!state.subExpanded.has(key)) continue
    const forest = (node.groups ?? []).flatMap((group) => group.forest)
    if (forest.length === 0) continue
    // Inline: grow straight out of the node's right edge (the rest of the tree
    // gets pushed right afterwards, so nothing is covered).
    const startX = mainPos.x + mainPos.w + SUB_COL_GAP
    const treeState = { cursor: mainPos.y + mainPos.h / 2 - SUB_H / 2 }
    const roots = []
    const walk = (sub, depth) => {
      const kids = state.subCollapsed.has(sub.id) ? [] : (sub.children ?? [])
      const x = startX + depth * (SUB_W + SUB_COL_GAP)
      let centerY
      if (kids.length === 0) {
        centerY = treeState.cursor + SUB_H / 2
        treeState.cursor += SUB_H + SUB_GAP_Y
      } else {
        const centers = kids.map((kid) => walk(kid, depth + 1))
        centerY = (centers[0] + centers[centers.length - 1]) / 2
      }
      const y = centerY - SUB_H / 2
      positions.set(`sub:${sub.id}`, { x, y, w: SUB_W, h: SUB_H, node: sub, kind: 'sub' })
      for (const kid of kids) {
        const childPos = positions.get(`sub:${kid.id}`)
        if (childPos === undefined) continue
        edges.push({
          from: { x: x + SUB_W, y: centerY },
          to: { x: childPos.x, y: childPos.y + SUB_H / 2 },
          current: false,
          kind: 'sub',
        })
      }
      return centerY
    }
    for (const sub of forest) roots.push({ id: sub.id, centerY: walk(sub, 0) })
    for (const root of roots) {
      const subPos = positions.get(`sub:${root.id}`)
      if (subPos === undefined) continue
      edges.push({
        from: { x: mainPos.x + mainPos.w, y: mainPos.y + mainPos.h / 2 },
        to: { x: subPos.x, y: subPos.y + SUB_H / 2 },
        current: false,
        kind: 'sub',
      })
    }
  }
  return { positions, edges }
}

/** Recompute main edges from final (possibly shifted) card positions. */
function rebuildMainEdges(graph, positions) {
  const edges = []
  for (const [key, pos] of positions) {
    const node = graph.nodes.get(key)
    if (node === undefined) continue
    for (const child of node.children) {
      const childPos = positions.get(child.key)
      if (childPos === undefined) continue
      edges.push({
        from: { x: pos.x + pos.w / 2, y: pos.y + pos.h },
        to: { x: childPos.x + childPos.w / 2, y: childPos.y },
        kind: child.kind,
        fromKey: key,
        toKey: child.key,
      })
    }
  }
  return edges
}

/**
 * Push main cards right until an expanded subagent forest no longer covers
 * them. Descendants move with their ancestor so a session's chain stays
 * straight; edges are rebuilt from the final positions.
 */
function resolveSubagentCollisions(graph, positions, subPositions) {
  if (subPositions.size === 0) return
  const visibleKeys = new Set(positions.keys())
  const descendants = (key) => {
    const keys = []
    const walk = (current) => {
      const node = graph.nodes.get(current)
      if (node === undefined) return
      for (const child of node.children) {
        if (!visibleKeys.has(child.key)) continue
        keys.push(child.key)
        walk(child.key)
      }
    }
    walk(key)
    return keys
  }
  for (let pass = 0; pass < 8; pass += 1) {
    let moved = false
    for (const sub of subPositions.values()) {
      const left = sub.x - 6
      const right = sub.x + sub.w + 6
      const top = sub.y - 6
      const bottom = sub.y + sub.h + 6
      for (const [key, pos] of positions) {
        if (pos.x + pos.w <= left) continue
        if (pos.x >= right) continue
        if (pos.y + pos.h <= top) continue
        if (pos.y >= bottom) continue
        const dx = right + 10 - pos.x
        if (dx <= 0) continue
        pos.x += dx
        for (const descendantKey of descendants(key)) {
          const descendantPos = positions.get(descendantKey)
          if (descendantPos !== undefined) descendantPos.x += dx
        }
        moved = true
      }
    }
    if (!moved) break
  }
}
// ── zoom / pan ──────────────────────────────────────────────────────────────
// ── minimap (top-right of the drawer) ───────────────────────────────────────
const MINIMAP_W = 132
const MINIMAP_H = 150

function minimapColors() {
  let style
  try {
    style = getComputedStyle(document.body)
  } catch {
    return { accent: '#3478f6', line: '#d8dee8', panel: '#ffffff', text: '#1f2937' }
  }
  const read = (name, fallback) => {
    const value = style.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    accent: read('--accent', '#3478f6'),
    line: read('--line', '#d8dee8'),
    panel: read('--panel', '#ffffff'),
    text: read('--text', '#1f2937'),
    muted: read('--muted', '#7c8798'),
    sub: read('--sub-card', '#fbfcff'),
  }
}

function drawMinimap() {
  const canvas = els.minimap
  const data = state.minimapData
  if (canvas === null || data === null) {
    if (canvas !== null) canvas.hidden = true
    return
  }
  canvas.hidden = false
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  const width = MINIMAP_W
  const height = MINIMAP_H
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const colors = minimapColors()

  const contentW = Math.max(1, data.width)
  const contentH = Math.max(1, data.height)
  const pad = 5
  // Independent axes: a conversation tree is tall and narrow, so a uniform
  // scale collapses it into a single ladder. Stretching X and compressing Y
  // keeps the branch columns visible in a compact map.
  const scaleX = (width - pad * 2) / contentW
  const scaleY = (height - pad * 2) / contentH

  // nodes: wide, shallow bars per column
  for (const item of data.items) {
    const scaledW = item.w * scaleX
    const w = Math.min(18, Math.max(2, scaledW))
    const x = pad + item.x * scaleX + Math.max(0, (scaledW - w) / 2)
    const y = pad + item.y * scaleY
    const h = Math.max(1.5, item.h * scaleY)
    ctx.fillStyle = item.current
      ? colors.accent
      : item.kind === 'sub'
        ? 'rgba(120, 130, 150, 0.30)'
        : 'rgba(120, 130, 150, 0.55)'
    ctx.fillRect(x, y, w, h)
  }

  // viewport rectangle (world coords → map coords)
  const viewLeft = -state.panX / state.zoom
  const viewTop = -state.panY / state.zoom
  const viewW = els.viewport.clientWidth / state.zoom
  const viewH = els.viewport.clientHeight / state.zoom
  const rx = pad + viewLeft * scaleX
  const ry = pad + viewTop * scaleY
  const rw = Math.max(2, viewW * scaleX)
  const rh = Math.max(2, viewH * scaleY)

  ctx.save()
  ctx.beginPath()
  ctx.rect(pad, pad, width - pad * 2, height - pad * 2)
  ctx.clip()
  ctx.fillStyle = 'rgba(52, 120, 246, 0.10)'
  ctx.fillRect(rx, ry, rw, rh)
  ctx.strokeStyle = colors.accent
  ctx.lineWidth = 1.4
  ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1)
  ctx.restore()
}

function installMinimap() {
  const canvas = els.minimap
  if (canvas === null) return
  const worldFromEvent = (event) => {
    const data = state.minimapData
    if (data === null) return null
    const rect = canvas.getBoundingClientRect()
    const pad = 5
    const scaleX = (MINIMAP_W - pad * 2) / Math.max(1, data.width)
    const scaleY = (MINIMAP_H - pad * 2) / Math.max(1, data.height)
    const x = (event.clientX - rect.left - pad) / scaleX
    const y = (event.clientY - rect.top - pad) / scaleY
    return { x, y }
  }
  const centerOnWorld = (world) => {
    const viewport = els.viewport
    state.panX = viewport.clientWidth / 2 - world.x * state.zoom
    state.panY = viewport.clientHeight / 2 - world.y * state.zoom
    applyTransform()
    saveCamera()
  }
  let dragging = false
  canvas.addEventListener('pointerdown', (event) => {
    event.stopPropagation()
    event.preventDefault()
    dragging = true
    const world = worldFromEvent(event)
    if (world !== null) centerOnWorld(world)
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
  })
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return
    event.stopPropagation()
    const world = worldFromEvent(event)
    if (world !== null) centerOnWorld(world)
  })
  const stop = () => {
    dragging = false
  }
  canvas.addEventListener('pointerup', stop)
  canvas.addEventListener('pointercancel', stop)
}

function applyTransform() {
  els.canvas.style.width = `${state.baseW}px`
  els.canvas.style.height = `${state.baseH}px`
  els.stage.style.width = `${state.baseW}px`
  els.stage.style.height = `${state.baseH}px`
  // Free camera: the whole stage is translated; nothing is clamped by scroll
  // bounds, so dragging can move the tree anywhere in the viewport (and past
  // its edges).
  els.stage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`
  els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`
  drawMinimap()
}

let cameraRetryTimer = null

function scheduleCameraRetry() {
  if (cameraRetryTimer !== null) return
  cameraRetryTimer = window.setTimeout(() => {
    cameraRetryTimer = null
    applyPendingCamera()
  }, 200)
}

function applyPendingCamera() {
  if (state.pendingCamera === null) return
  if (!viewportVisible()) {
    // Layout may settle a frame later (or the tab is still display:none).
    scheduleCameraRetry()
    return
  }
  const camera = state.pendingCamera
  state.pendingCamera = null
  state.zoom = camera.zoom
  state.panX = camera.panX
  state.panY = camera.panY
  applyTransform()
  saveCamera()
}

function setZoom(next, focalX, focalY) {
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next))
  if (Math.abs(clamped - state.zoom) < 0.0005) return
  const viewport = els.viewport
  const fx = typeof focalX === 'number' ? focalX : viewport.clientWidth / 2
  const fy = typeof focalY === 'number' ? focalY : viewport.clientHeight / 2
  const worldX = (fx - state.panX) / state.zoom
  const worldY = (fy - state.panY) / state.zoom
  state.zoom = clamped
  state.panX = fx - worldX * clamped
  state.panY = fy - worldY * clamped
  applyTransform()
  saveCamera()
}

// ── rendering ───────────────────────────────────────────────────────────────
function edgePath(edge) {
  if (edge.kind === 'chain' || edge.kind === 'branch') {
    const midY = (edge.from.y + edge.to.y) / 2
    return `M ${edge.from.x} ${edge.from.y} V ${midY} H ${edge.to.x} V ${edge.to.y}`
  }
  const midX = (edge.from.x + edge.to.x) / 2
  return `M ${edge.from.x} ${edge.from.y} H ${midX} V ${edge.to.y} H ${edge.to.x}`
}

function currentSessionAnchorKey(graph) {
  const session = [...graph.nodes.values()].map((node) => node.session).find((candidate) => candidate.current === true)
  if (session === undefined) return null
  // Show where THIS branch starts (its first own round / blank node); the newest
  // rounds sit below and are reachable by dragging. For a root session this is
  // simply its first round.
  return firstNodeKey(session)
}

function openComposer(node, pos, offsetX, offsetY) {
  const left = pos.x + offsetX - COMPOSER_W - 16
  state.composer = {
    key: node.key,
    sessionId: node.session.id,
    seq: node.round.endSeq,
    left,
    top: Math.max(8, pos.y + offsetY),
    text: '',
    error: null,
    busy: false,
    customOpen: false,
  }
  state.composerFocus = true
  render()
}

function revealComposer() {
  if (state.composer === null || !viewportVisible()) return
  const viewport = els.viewport
  const left = state.composer.left * state.zoom + state.panX
  const top = state.composer.top * state.zoom + state.panY
  const right = (state.composer.left + COMPOSER_W) * state.zoom + state.panX
  const bottom = (state.composer.top + COMPOSER_H) * state.zoom + state.panY
  let changed = false
  if (left < 8) {
    state.panX += 8 - left
    changed = true
  }
  if (right > viewport.clientWidth - 8) {
    state.panX -= right - (viewport.clientWidth - 8)
    changed = true
  }
  if (top < 8) {
    state.panY += 8 - top
    changed = true
  }
  if (bottom > viewport.clientHeight - 8) {
    state.panY -= bottom - (viewport.clientHeight - 8)
    changed = true
  }
  if (changed) {
    applyTransform()
    saveCamera()
  }
}

function closeComposer() {
  state.composer = null
  state.composerBusy = false
  state.composerFocus = false
  render()
}

function showToast(text) {
  let toast = document.getElementById('nav-toast')
  if (toast === null) {
    toast = document.createElement('div')
    toast.id = 'nav-toast'
    toast.className = 'nav-toast'
    document.body.append(toast)
  }
  toast.textContent = text
  toast.hidden = false
  clearTimeout(showToast.timer)
  showToast.timer = window.setTimeout(() => {
    toast.hidden = true
  }, 6000)
}

function sendComposerPrompt(text) {
  const composer = state.composer
  if (composer === null || composer.busy) return
  const message = String(text).replace(/\s+/g, ' ').trim()
  if (message === '') return
  composer.text = message
  composer.busy = true
  composer.error = null
  render()
  window.parent.postMessage(
    {
      source: 'dsh-branch-tree',
      type: 'fork-round',
      sessionId: composer.sessionId,
      seq: composer.seq,
      text: message,
    },
    location.origin,
  )
}

function renderComposer() {
  const composer = state.composer
  if (composer === null) return null
  const makeElement = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className !== undefined) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const box = document.createElement('div')
  box.className = 'composer'
  box.style.left = `${composer.left}px`
  box.style.top = `${composer.top}px`
  box.addEventListener('click', (event) => event.stopPropagation())
  box.addEventListener('pointerdown', (event) => event.stopPropagation())

  const head = document.createElement('div')
  head.className = 'composer-head'
  head.append(makeElement('span', 'dot current'))
  head.append(makeElement('span', 'composer-title', '新的追问'))
  box.append(head)

  const chips = document.createElement('div')
  chips.className = 'composer-chips'
  const addChip = (text, custom) => {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = `chip${custom ? ' custom' : ''}`
    chip.textContent = text
    chip.disabled = composer.busy === true
    chip.title = '点击直接发送并开分支'
    chip.addEventListener('click', (event) => {
      event.stopPropagation()
      sendComposerPrompt(text)
    })
    chips.append(chip)
  }
  for (const text of DEFAULT_CHIPS) addChip(text, false)
  for (const text of state.customChips) addChip(text, true)

  const plus = document.createElement('button')
  plus.type = 'button'
  plus.className = 'chip plus'
  plus.textContent = '+'
  plus.title = '新增自定义快捷词'
  plus.addEventListener('click', (event) => {
    event.stopPropagation()
    composer.customOpen = composer.customOpen !== true
    render()
  })
  chips.append(plus)
  box.append(chips)

  if (composer.customOpen === true) {
    const add = document.createElement('input')
    add.className = 'composer-custom'
    add.placeholder = '自定义快捷词，回车添加'
    add.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        const value = add.value.replace(/\s+/g, ' ').trim()
        if (value !== '' && state.customChips.length < 6 && !state.customChips.includes(value)) {
          state.customChips.push(value)
          saveCustomChips()
        }
        composer.customOpen = false
        render()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        composer.customOpen = false
        render()
      }
    })
    box.append(add)
    window.setTimeout(() => add.focus(), 0)
  }

  const textarea = document.createElement('textarea')
  textarea.className = 'composer-input'
  textarea.placeholder = '输入追问'
  textarea.value = composer.text
  textarea.disabled = composer.busy === true
  textarea.addEventListener('input', () => {
    composer.text = textarea.value
  })
  textarea.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      sendComposerPrompt(textarea.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeComposer()
    }
  })
  box.append(textarea)

  if (typeof composer.error === 'string' && composer.error !== '') {
    box.append(makeElement('div', 'composer-error', composer.error))
  }

  const actions = document.createElement('div')
  actions.className = 'composer-actions'
  if (composer.busy === true) {
    actions.append(makeElement('span', 'composer-busy', '正在创建分支…'))
  }
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'composer-cancel'
  cancel.textContent = '×'
  cancel.title = '取消'
  cancel.disabled = composer.busy === true
  cancel.addEventListener('click', (event) => {
    event.stopPropagation()
    closeComposer()
  })
  const send = document.createElement('button')
  send.type = 'button'
  send.className = 'composer-send'
  send.textContent = '↑'
  send.title = '发送并开分支（⌘/Ctrl+Enter）'
  send.disabled = composer.busy === true
  send.addEventListener('click', (event) => {
    event.stopPropagation()
    sendComposerPrompt(textarea.value)
  })
  actions.append(cancel, send)
  box.append(actions)

  if (state.composerFocus === true) {
    state.composerFocus = false
    window.setTimeout(() => textarea.focus(), 0)
  }
  return box
}

function render() {
  // A payload refresh replaces the DOM; drop any in-flight rename input.
  state.editingBranch = null
  const data = state.data
  els.loading.hidden = true
  els.error.hidden = true
  els.empty.hidden = true

  if (data === null || !Array.isArray(data.sessions) || data.sessions.length === 0) {
    state.minimapData = null
    drawMinimap()
    els.stage.hidden = true
    els.empty.hidden = false
    els.emptyText.textContent = state.sessionId === '' ? '未选择会话' : '当前会话不在活动列表中'
    return
  }

  const graph = buildGraph(data.sessions)
  const main = layoutMain(graph)
  const sub = layoutSubagents(main.positions)
  resolveSubagentCollisions(graph, main.positions, sub.positions)
  main.edges = rebuildMainEdges(graph, main.positions)
  const allPositions = [...main.positions.values(), ...sub.positions.values()]

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const pos of allPositions) {
    minX = Math.min(minX, pos.x)
    minY = Math.min(minY, pos.y)
    maxX = Math.max(maxX, pos.x + pos.w)
    maxY = Math.max(maxY, pos.y + pos.h)
  }
  if (!Number.isFinite(minX)) {
    state.minimapData = null
    drawMinimap()
    els.stage.hidden = true
    els.empty.hidden = false
    els.emptyText.textContent = '没有可显示的分支'
    return
  }
  const offsetX = PAD - minX
  const offsetY = PAD - minY
  state.offsetX = offsetX
  state.offsetY = offsetY
  state.baseW = maxX - minX + PAD * 2
  state.baseH = maxY - minY + PAD * 2

  const minimapItems = []
  for (const pos of main.positions.values()) {
    minimapItems.push({
      x: pos.x + offsetX,
      y: pos.y + offsetY,
      w: pos.w,
      h: pos.h,
      kind: 'main',
      current: pos.node.session.current === true,
    })
  }
  for (const pos of sub.positions.values()) {
    minimapItems.push({
      x: pos.x + offsetX,
      y: pos.y + offsetY,
      w: pos.w,
      h: pos.h,
      kind: 'sub',
      current: false,
    })
  }
  state.minimapData = { items: minimapItems, width: state.baseW, height: state.baseH }

  els.stage.hidden = false
  applyTransform()
  els.edges.setAttribute('width', String(state.baseW))
  els.edges.setAttribute('height', String(state.baseH))
  els.edges.setAttribute('viewBox', `0 0 ${state.baseW} ${state.baseH}`)
  els.edges.replaceChildren()
  els.nodes.replaceChildren()

  for (const edge of [...main.edges, ...sub.edges]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute(
      'd',
      edgePath({
        from: { x: edge.from.x + offsetX, y: edge.from.y + offsetY },
        to: { x: edge.to.x + offsetX, y: edge.to.y + offsetY },
        kind: edge.kind,
      }),
    )
    const classes = ['edge']
    if (edge.kind === 'sub') classes.push('sub-edge')
    if (edge.kind === 'branch') classes.push('branch-edge')
    path.setAttribute('class', classes.join(' '))
    els.edges.append(path)
  }

  // Branch names sit ON the branch connector (the horizontal jog between the
  // fork round and the branch's first box) instead of floating over a card —
  // that kept colliding with the card corner and the connector itself.
  let branchLabelIndex = 0
  for (const edge of main.edges) {
    if (edge.kind !== 'branch') continue
    const fromPos = main.positions.get(edge.fromKey)
    const toPos = main.positions.get(edge.toKey)
    if (fromPos === undefined || toPos === undefined) continue
    const session = toPos.node.session
    const info = branchInfo(session)
    const label = document.createElement('button')
    label.type = 'button'
    label.className = `branch-label${info.custom ? ' custom' : ''}`
    label.style.left = `${(fromPos.x + fromPos.w / 2 + toPos.x + toPos.w / 2) / 2 + offsetX}px`
    label.style.top = `${(fromPos.y + fromPos.h + toPos.y) / 2 + offsetY + (branchLabelIndex % 2 === 0 ? 0 : 9)}px`
    branchLabelIndex += 1
    label.textContent = `↳ ${info.name}`
    label.title = info.custom ? '分支名（手动命名，双击可改）' : '分支名（自动，双击可改）'
    label.addEventListener('click', (event) => event.stopPropagation())
    label.addEventListener('pointerdown', (event) => event.stopPropagation())
    label.addEventListener('dblclick', (event) => {
      event.stopPropagation()
      event.preventDefault()
      beginBranchRename(session, label)
    })
    els.nodes.append(label)
  }

  let subagentTotal = 0
  for (const node of main.positions.values()) {
    for (const group of node.node.groups ?? []) subagentTotal += countSubagents(group.forest)
  }

  const rendered = new Set()
  for (const [key, pos] of main.positions) {
    els.nodes.append(renderNode(pos, offsetX, offsetY))
    if (!state.subExpanded.has(key) || pos.node.groups.length === 0) continue
    const collect = (forest) => {
      for (const subNode of forest ?? []) {
        const subKey = `sub:${subNode.id}`
        if (!rendered.has(subKey) && sub.positions.has(subKey)) {
          rendered.add(subKey)
          els.nodes.append(renderSubCard(sub.positions.get(subKey), offsetX, offsetY))
        }
        collect(subNode.children)
      }
    }
    for (const group of pos.node.groups) collect(group.forest)
  }

  if (state.pendingReveal !== null && sub.positions.size > 0) {
    const anchor = [...sub.positions.values()].reduce(
      (best, pos) => (pos.x < best.x ? pos : best),
      [...sub.positions.values()][0],
    )
    state.panX = els.viewport.clientWidth * 0.45 - (anchor.x + offsetX) * state.zoom
    state.panY = 140 - (anchor.y + offsetY) * state.zoom
    applyTransform()
    saveCamera()
    state.pendingReveal = null
  }

  if (state.composer !== null) {
    const composerBox = renderComposer()
    if (composerBox !== null) els.nodes.append(composerBox)
    revealComposer()
  }

  const roundCount = [...main.positions.values()].filter((pos) => pos.node.kind === 'round').length
  const titleParts = [`${roundCount} 轮`]
  if (subagentTotal > 0) titleParts.push(`${subagentTotal} 个子代理`)
  els.count.textContent = titleParts.join(' · ')
  els.hint.hidden = main.positions.size > 1
  if (data.truncated === true) els.count.textContent += ' · 已截断'

  if (state.camera !== null) {
    // Keep the reader's viewport across session switches / tab reopens. Apply
    // it now when visible, otherwise wait for the tab to be shown again.
    state.pendingCamera = state.camera
    state.camera = null
  }
  if (state.firstRender && state.pendingCamera === null) {
    state.firstRender = false
    centerOn(currentSessionAnchorKey(graph), main.positions, offsetX, offsetY)
  }
  // A camera pushed by the parent page (restore-camera) may arrive BEFORE the
  // tree finishes loading; apply it here instead of dropping it.
  applyPendingCamera()
}

function centerOn(key, positions, offsetX, offsetY) {
  if (key === null) return
  const pos = positions.get(key)
  if (pos === undefined) return
  const viewport = els.viewport
  state.panX = viewport.clientWidth / 2 - (pos.x + offsetX + pos.w / 2) * state.zoom
  state.panY = viewport.clientHeight / 2 - (pos.y + offsetY + pos.h / 2) * state.zoom
  applyTransform()
  saveCamera()
}

function renderNode(pos, offsetX, offsetY) {
  const node = pos.node
  const session = node.session
  const wrapper = document.createElement('div')
  wrapper.className = `node ${node.kind === 'blank' ? 'blank' : ''}${session.current ? ' current-session' : ''}`
  wrapper.style.left = `${pos.x + offsetX}px`
  wrapper.style.top = `${pos.y + offsetY}px`
  wrapper.style.width = `${pos.w}px`
  wrapper.style.height = `${pos.h}px`

  if (session.current) {
    const bar = document.createElement('span')
    bar.className = 'session-bar'
    wrapper.append(bar)
  }

  const card = document.createElement('div')
  card.className = 'card'
  if (session.current && node.kind === 'round' && node.ordinal === session.rounds.length - 1) card.classList.add('current')
  if (node.kind === 'blank') card.classList.add('blank-card')

  const head = document.createElement('div')
  head.className = 'card-head'
  const dot = document.createElement('span')
  dot.className = 'dot'
  if (session.current) dot.classList.add('current')
  if (node.kind === 'round' && node.round.incomplete) dot.classList.add('running')
  head.append(dot)

  const title = document.createElement('span')
  title.className = 'card-title'
  title.textContent = node.kind === 'blank' ? '空白分支' : roundTitle(node.round)
  head.append(title)
  card.append(head)

  if (node.kind === 'round') {
    if (node.round.user) card.append(lineEl('你', node.round.user))
    if (node.round.assistant) card.append(lineEl('AI', node.round.assistant))
  } else {
    card.append(lineEl('·', '空白分支 · 尚未提问'))
  }

  const meta = document.createElement('div')
  meta.className = 'card-meta'
  if (node.kind === 'round') {
    if (node.round.incomplete) meta.append(badge('进行中'))
    if (session.current) meta.append(badge('当前'))
  } else {
    meta.append(badge('空白'))
  }

  const groupCount = (node.groups ?? []).reduce((total, group) => total + countSubagents(group.forest), 0)
  if (groupCount > 0) {
    const open = state.subExpanded.has(node.key)
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = `sub-chip${open ? ' open' : ''}`
    chip.textContent = `${open ? '◂' : '▸'} 代理 ${groupCount}`
    chip.title = open ? '收起子代理' : '在右侧展开子代理'
    chip.addEventListener('click', (event) => {
      event.stopPropagation()
      if (state.subExpanded.has(node.key)) {
        state.subExpanded.delete(node.key)
        state.pendingReveal = null
      } else {
        state.subExpanded.clear()
        state.subExpanded.add(node.key)
        state.pendingReveal = node.key
      }
      render()
    })
    meta.append(chip)
  }
  if (meta.childElementCount > 0) card.append(meta)

  card.addEventListener('click', () => {
    navigate(
      session.id,
      node.kind === 'round' ? (node.round.userSeq ?? node.round.endSeq ?? null) : null,
    )
  })
  wrapper.append(card)

  // New branch from this round (hover): a tiny "+" on the card's left edge.
  if (node.kind === 'round' && node.round.incomplete !== true) {
    const fork = document.createElement('button')
    fork.type = 'button'
    fork.className = 'fork-btn'
    fork.title = '从这一轮开启新分支（追问）'
    fork.setAttribute('aria-label', '从这一轮开启新分支')
    fork.addEventListener('pointerdown', (event) => event.stopPropagation())
    fork.addEventListener('click', (event) => {
      event.stopPropagation()
      openComposer(node, pos, offsetX, offsetY)
    })
    wrapper.append(fork)
  }

  const childCount = node.children.length
  if (childCount > 0) {
    const folded = state.collapsed.has(node.key)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `fold${folded ? ' folded' : ''}`
    button.title = folded ? `展开后续（${countDescendants(node.key)} 条）` : '收起后续'
    button.append(spanEl('chevron', folded ? '▸' : '▾'))
    if (folded) button.append(spanEl('fold-count', String(countDescendants(node.key))))
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (state.collapsed.has(node.key)) state.collapsed.delete(node.key)
      else state.collapsed.add(node.key)
      render()
    })
    wrapper.append(button)
  }

  return wrapper
}

function beginBranchRename(session, badgeEl) {
  if (state.editingBranch !== null) return
  const input = document.createElement('input')
  input.className = 'branch-name-input'
  input.value = branchInfo(session).name
  input.maxLength = 60
  input.setAttribute('aria-label', '分支名称')
  input.title = '回车保存 · Esc 取消'
  state.editingBranch = session.id
  input.style.left = badgeEl.style.left
  input.style.top = badgeEl.style.top
  input.style.transform = badgeEl.style.transform
  badgeEl.replaceWith(input)
  input.focus()
  input.select()
  let finished = false
  const finish = (commit) => {
    if (finished) return
    finished = true
    state.editingBranch = null
    if (commit) {
      const value = input.value.trim()
      if (value !== '') saveBranchName(session.id, value)
    }
    render()
  }
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      finish(false)
    }
  })
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('click', (event) => event.stopPropagation())
  input.addEventListener('pointerdown', (event) => event.stopPropagation())
}

function lineEl(tag, text) {
  const line = document.createElement('div')
  line.className = tag === '你' ? 'line user' : 'line ai'
  line.append(spanEl('tag', tag))
  const txt = spanEl('txt', text)
  txt.title = text
  line.append(txt)
  return line
}

function spanEl(className, text) {
  const node = document.createElement('span')
  if (className !== '') node.className = className
  node.textContent = text
  return node
}

function badge(text) {
  const node = document.createElement('span')
  node.className = 'badge'
  node.textContent = text
  return node
}

function textMeta(text) {
  const node = document.createElement('span')
  node.className = 'meta-text'
  node.textContent = text
  return node
}

function countDescendants(key) {
  const graph = state.graphCache
  if (graph === undefined) return 0
  const node = graph.nodes.get(key)
  if (node === undefined) return 0
  let total = 0
  const walk = (current) => {
    for (const child of current.children) {
      total += 1
      const next = graph.nodes.get(child.key)
      if (next !== undefined) walk(next)
    }
  }
  walk(node)
  return total
}

function countSubagents(forest) {
  let total = 0
  for (const node of forest ?? []) total += 1 + countSubagents(node.children)
  return total
}

function renderSubCard(pos, offsetX, offsetY) {
  const sub = pos.node
  const wrapper = document.createElement('div')
  wrapper.className = 'node sub'
  wrapper.style.left = `${pos.x + offsetX}px`
  wrapper.style.top = `${pos.y + offsetY}px`
  wrapper.style.width = `${pos.w}px`
  wrapper.style.height = `${pos.h}px`

  const classes = ['card']
  if (sub.diagnostic) classes.push('diagnostic')
  if (sub.activity === 'running') classes.push('running')
  const card = document.createElement('div')
  card.className = classes.join(' ')

  const head = document.createElement('div')
  head.className = 'card-head'
  const dot = document.createElement('span')
  dot.className = `dot${sub.activity === 'running' ? ' running' : ''}`
  head.append(dot)
  head.append(spanEl('card-title', sub.title || '子代理'))
  card.append(head)

  if (sub.round && sub.round.user) card.append(lineEl('你', sub.round.user))
  if (sub.round && sub.round.assistant) card.append(lineEl('AI', sub.round.assistant))
  if (sub.empty) card.append(lineEl('·', '（暂无轮次）'))

  const meta = document.createElement('div')
  meta.className = 'card-meta'
  meta.append(badge(sub.mode === 'continuable' ? '可续' : '一次性'))
  if (sub.diagnostic) meta.append(badge('诊断'))
  card.append(meta)

  card.title = sub.title || ''
  card.addEventListener('click', (event) => {
    event.stopPropagation()
    if ((sub.children ?? []).length === 0) return
    if (state.subCollapsed.has(sub.id)) state.subCollapsed.delete(sub.id)
    else state.subCollapsed.add(sub.id)
    render()
  })
  wrapper.append(card)

  if ((sub.children ?? []).length > 0) {
    const folded = state.subCollapsed.has(sub.id)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fold'
    button.title = folded ? '展开子代理' : '收起子代理'
    button.append(spanEl('chevron', folded ? '▸' : '▾'))
    button.append(spanEl('', String(countSubagents(sub.children))))
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (state.subCollapsed.has(sub.id)) state.subCollapsed.delete(sub.id)
      else state.subCollapsed.add(sub.id)
      render()
    })
    wrapper.append(button)
  }
  return wrapper
}

// ── bridge / data ───────────────────────────────────────────────────────────
function navigate(sessionId, seq) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  window.parent.postMessage(
    {
      source: 'dsh-branch-tree',
      type: 'open-session',
      sessionId,
      seq: typeof seq === 'number' && Number.isFinite(seq) ? seq : null,
    },
    location.origin,
  )
}

function updateRailToggle() {
  const button = els.railToggle
  if (button === null) return
  if (state.railMirrored) button.classList.add('active')
  else button.classList.remove('active')
  button.title = `轮次导航条镜像到左侧：${state.railMirrored ? '开' : '关'}（点击切换）`
}

function showNavError(message) {
  let toast = document.getElementById('nav-toast')
  if (toast === null) {
    toast = document.createElement('div')
    toast.id = 'nav-toast'
    toast.className = 'nav-toast'
    document.body.append(toast)
  }
  toast.textContent = `跳转失败：${message}`
  toast.hidden = false
  clearTimeout(showNavError.timer)
  showNavError.timer = window.setTimeout(() => {
    toast.hidden = true
  }, 7000)
}

/**
 * Jump the MAIN conversation view to one turn. The tab is same-origin with the
 * app, so after asking the host to open the target session this polls the
 * parent document for the chat row carrying `data-chat-turn` and scrolls it into
 * view. Works across branches (the row appears after the session switch).
 */
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return
  const data = event.data
  if (data === null || typeof data !== 'object' || data.source !== 'dsh-branch-tree') return
  if (data.type === 'refresh') {
    applyPendingCamera()
    void load(false)
    return
  }
  if (data.type === 'restore-camera') {
    acceptCamera(data.camera)
    return
  }
  if (data.type === 'rail-state') {
    state.railMirrored = data.on === true
    updateRailToggle()
    return
  }
  if (data.type === 'fork-done') {
    state.composer = null
    state.composerFocus = false
    showToast('已创建新分支，正在切换…')
    render()
    void load(false)
    return
  }
  if (data.type === 'fork-error') {
    if (state.composer !== null) {
      state.composer.busy = false
      state.composer.error = typeof data.message === 'string' && data.message !== '' ? data.message : '创建分支失败'
    }
    render()
    return
  }
  if (data.type === 'nav-error') {
    showNavError(typeof data.message === 'string' && data.message !== '' ? data.message : '未知错误')
    return
  }
  if (data.type === 'session' && typeof data.sessionId === 'string' && data.sessionId !== state.sessionId) {
    if (state.data !== null && viewportVisible()) saveCamera()
    state.sessionId = data.sessionId
    state.dataJson = ''
    state.firstRender = false
    state.camera = readCamera()
    state.subExpanded.clear()
    state.pendingReveal = null
    state.composer = null
    state.composerFocus = false
    void load(true)
  }
})

async function load(showLoading) {
  if (state.sessionId === '') {
    els.loading.hidden = true
    els.stage.hidden = true
    els.empty.hidden = false
    els.emptyText.textContent = '未选择会话'
    return
  }
  if (showLoading) {
    els.loading.hidden = false
    els.empty.hidden = true
    els.error.hidden = true
  }
  try {
    const response = await fetch(`/branch-tree/api/tree?sessionId=${encodeURIComponent(state.sessionId)}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ''}`)
    }
    const payload = await response.json()
    const serialized = JSON.stringify(payload)
    if (serialized === state.dataJson) return
    state.dataJson = serialized
    state.data = payload
    state.graphCache = buildGraph(payload.sessions)
    state.loading = false
    els.loading.hidden = true
    render()
  } catch (error) {
    state.loading = false
    state.error = error instanceof Error ? error.message : String(error)
    els.loading.hidden = true
    els.stage.hidden = true
    els.empty.hidden = true
    els.error.hidden = false
    els.errorText.textContent = `加载失败：${state.error}`
  }
}

// ── pan & pinch / wheel zoom ───────────────────────────────────────────────
const pointers = new Map()
let drag = null
let pinch = null

function resetSuppressClickSoon() {
  window.setTimeout(() => {
    state.suppressClick = false
  }, 0)
}

function endPointer(event) {
  pointers.delete(event.pointerId)
  if (pointers.size < 2) pinch = null
  if (pointers.size === 0) {
    if (state.suppressClick) resetSuppressClickSoon()
    drag = null
    els.viewport.classList.remove('dragging')
    saveCamera()
  }
}

function installPanZoom() {
  const viewport = els.viewport

  viewport.addEventListener(
    'wheel',
    (event) => {
      const target = event.target
      if (target instanceof Element && target.closest('.composer') !== null) return
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        const rect = viewport.getBoundingClientRect()
        const factor = Math.exp(-event.deltaY * 0.01)
        setZoom(state.zoom * factor, event.clientX - rect.left, event.clientY - rect.top)
        return
      }
      state.panX -= event.deltaX
      state.panY -= event.deltaY
      applyTransform()
    },
    { passive: false },
  )

  viewport.addEventListener('pointerdown', (event) => {
    // Never start a drag (nor capture the pointer) on an interactive control:
    // pointer capture retargets pointerup to the viewport, which silently
    // swallows the button/card click that follows.
    const target = event.target
    if (state.composer !== null) {
      const inside =
        target instanceof Element &&
        (target.closest('.composer') !== null || target.closest('.fork-btn') !== null)
      if (!inside) {
        state.composer = null
        state.composerFocus = false
        render()
      }
    }
    if (target instanceof Element && target.closest('.composer') !== null) return
    if (target instanceof Element && target.closest('button, input, textarea, select, a') !== null) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 1) {
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        panX: state.panX,
        panY: state.panY,
        moved: false,
      }
      pinch = null
    } else if (pointers.size === 2) {
      const pts = [...pointers.values()]
      drag = null
      pinch = {
        distance: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        zoom: state.zoom,
      }
      state.suppressClick = true
    }
  })

  viewport.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pointers.size >= 2 && pinch !== null) {
      const pts = [...pointers.values()]
      const distance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1
      const rect = viewport.getBoundingClientRect()
      const midX = (pts[0].x + pts[1].x) / 2 - rect.left
      const midY = (pts[0].y + pts[1].y) / 2 - rect.top
      setZoom(pinch.zoom * (distance / pinch.distance), midX, midY)
      return
    }

    if (drag === null || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
    drag.moved = true
    state.suppressClick = true
    viewport.classList.add('dragging')
    state.panX = drag.panX + dx
    state.panY = drag.panY + dy
    applyTransform()
  })

  viewport.addEventListener('pointerup', endPointer)
  viewport.addEventListener('pointercancel', endPointer)
  viewport.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'touch') endPointer(event)
  })

  viewport.addEventListener(
    'click',
    (event) => {
      if (!state.suppressClick) return
      event.stopPropagation()
      event.preventDefault()
      state.suppressClick = false
    },
    true,
  )
}

// ── wiring ──────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  applyPendingCamera()
  drawMinimap()
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.composer !== null) closeComposer()
})

function requestSessionFromParent() {
  let tries = 0
  const ask = () => {
    if (state.sessionId !== '') return
    window.parent.postMessage({ source: 'dsh-branch-tree', type: 'request-session' }, location.origin)
    window.parent.postMessage({ source: 'dsh-branch-tree', type: 'request-camera' }, location.origin)
    tries += 1
    if (tries < 40) window.setTimeout(ask, 300)
  }
  ask()
}

els.version.textContent = 'v0.1.0'
state.branchNames = loadBranchNames()
observeTheme()
installPanZoom()
installMinimap()
updateRailToggle()

els.refresh.addEventListener('click', () => {
  void load(true)
})
els.reload.addEventListener('click', () => {
  location.reload()
})
els.retry.addEventListener('click', () => {
  void load(true)
})
els.railToggle.addEventListener('click', () => {
  window.parent.postMessage(
    { source: 'dsh-branch-tree', type: 'toggle-rail', on: !state.railMirrored },
    location.origin,
  )
})
els.zoomIn.addEventListener('click', () => {
  setZoom(state.zoom * 1.2)
})
els.zoomOut.addEventListener('click', () => {
  setZoom(state.zoom / 1.2)
})
els.zoomReset.addEventListener('click', () => {
  state.zoom = 1
  applyTransform()
  const graph = state.data === null ? null : buildGraph(state.data.sessions)
  if (graph === null) return
  const main = layoutMain(graph)
  centerOn(currentSessionAnchorKey(graph), main.positions, state.offsetX, state.offsetY)
})

// Cheap live refresh: new rounds in any branch show up as new boxes.
window.setInterval(() => {
  if (document.visibilityState !== 'visible') return
  if (pointers.size > 0) return
  if (state.editingBranch !== null) return
  if (state.composer !== null) return
  void load(false)
}, POLL_MS)

if (state.sessionId === '') requestSessionFromParent()
void load(true)
