/*!
 * dsh-branch-tree — client half: a persistent right-hand drawer.
 *
 * The tree is a persistent right-hand drawer mounted once in the page. It only
 * receives data updates, so its iframe, zoom, scroll and expansion state
 * survive conversation switches untouched (a per-session sidebar tab would be
 * re-created on every switch).
 *
 * Session source: the Session retained by the main view
 * (`sessions.list` rows with `retainedBy.mainView > 0`), the same signal
 * dsh-synapse uses. Clicking a tree card opens that session in the main view
 * (uiWorkspace) and, for a round, scrolls the chat to the exact event seq.
 *
 * Bundle format: window.__ModuleLoader__.load({ id, factory }). No React
 * dependency — this half only owns DOM + services.
 */
window.__ModuleLoader__.load({
  id: 'dsh-branch-tree',
  factory: () => {
    var module = { exports: {} }

    var inject = ['sessions', 'uiWorkspace', 'uiConversation']

    /** Cordis services must be read through ctx.get (property access needs inject). */
    function readService(ctx, name) {
      try {
        if (ctx === null || ctx === undefined) return undefined
        if (typeof ctx.get === 'function') return ctx.get(name)
        return undefined
      } catch {
        return undefined
      }
    }

    var CAMERA_KEY = 'dsh-branch-tree:camera:v1'
    var OPEN_KEY = 'dsh-branch-tree:drawer-open'
    var DRAWER_WIDTH = 'min(460px, 94vw)'

    function readCamera() {
      try {
        var raw = localStorage.getItem(CAMERA_KEY)
        if (raw === null) return null
        var camera = JSON.parse(raw)
        if (camera === null || typeof camera !== 'object' || typeof camera.zoom !== 'number') return null
        return camera
      } catch {
        return null
      }
    }

    function apply(ctx) {
      var sessions = readService(ctx, 'sessions')
      var conversation = readService(ctx, 'uiConversation')
      var workspace = readService(ctx, 'uiWorkspace')
      var layout = readService(ctx, 'layout')
      var getLayout = function () {
        if (layout === undefined || layout === null) layout = readService(ctx, 'layout')
        return layout
      }

      var host = document.createElement('div')
      host.id = 'dsh-branch-tree-host'
      host.style.cssText =
        'position:fixed;top:0;right:0;bottom:0;width:' +
        DRAWER_WIDTH +
        ';z-index:62;pointer-events:none;transform:translateX(100%);transition:transform .18s ease;will-change:transform;'

      var frame = document.createElement('iframe')
      frame.src = '/branch-tree/ui'
      frame.title = '分支树'
      frame.style.cssText =
        'width:100%;height:100%;border:0;display:block;background:var(--dsw-alias-bg-base,#fff);border-radius:12px 0 0 12px;box-shadow:-10px 0 28px rgba(15,23,42,.16);'
      frame.setAttribute('allow', 'clipboard-read; clipboard-write')

      var handle = document.createElement('button')
      handle.type = 'button'
      handle.id = 'dsh-branch-tree-handle'
      handle.title = '分支树（点击展开/收起）'
      handle.setAttribute('aria-label', '切换分支树面板')
      handle.textContent = '⑂'
      handle.style.cssText =
        'position:absolute;left:-32px;top:50%;transform:translateY(-50%);width:32px;height:64px;' +
        'display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;pointer-events:auto;' +
        'border:1px solid var(--dsw-alias-border-l1,#d6dae1);border-right:0;border-radius:10px 0 0 10px;' +
        'background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-secondary,#5b6472);' +
        'font:600 15px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;' +
        'box-shadow:-4px 0 12px rgba(15,23,42,.10);'

      host.append(frame, handle)
      document.body.append(host)

      // Transition helper for whichever container ends up being squeezed.
      var pushStyle = document.createElement('style')
      pushStyle.setAttribute('data-dsh-branch-tree-push', '')
      pushStyle.textContent =
        '.dsh-branch-tree-push-target{transition:margin-right .18s ease,padding-right .18s ease,width .18s ease,max-width .18s ease}'
      document.head.append(pushStyle)

      // ── squeeze the shell instead of covering it ────────────────────────
      // The layout frame's own right column did not reflow in practice, so the
      // width is taken directly from the widest shell container and verified by
      // measuring the conversation column after each candidate style. The
      // variant that actually shrinks the chat is kept; the rest are reverted.
      var drawerWidth = function () {
        try {
          return Math.round(host.getBoundingClientRect().width) || Math.min(460, Math.round(window.innerWidth * 0.94))
        } catch {
          return Math.min(460, Math.round(window.innerWidth * 0.94))
        }
      }
      var chatWidth = function () {
        var scroller = document.querySelector('[data-conversation-scroll]')
        var flow = document.querySelector('[data-chat-flow]')
        var element = scroller !== null ? scroller : flow
        if (element === null) return 0
        try {
          return element.getBoundingClientRect().width
        } catch {
          return 0
        }
      }
      var shellFrame = null
      var findShell = function () {
        if (shellFrame !== null && shellFrame.isConnected) return shellFrame
        var bottom = document.querySelector('[data-shell-bottom]')
        if (bottom !== null) shellFrame = bottom.parentElement
        if (shellFrame === null) {
          var overlay = document.querySelector('[data-shell-overlay]')
          if (overlay !== null) shellFrame = overlay.parentElement
        }
        return shellFrame
      }
      var pushTargets = function () {
        var list = []
        var push = function (element) {
          if (element === null || element === undefined) return
          if (list.indexOf(element) !== -1) return
          list.push(element)
        }
        push(findShell())
        try {
          var all = document.querySelectorAll('body *')
          var widest = null
          var widestWidth = 0
          for (var index = 0; index < all.length; index += 1) {
            var element = all[index]
            var style = window.getComputedStyle(element)
            if (style.display !== 'grid') continue
            var columns = style.gridTemplateColumns.split(' ')
            if (columns.length !== 3) continue
            var width = element.getBoundingClientRect().width
            if (width > widestWidth) {
              widest = element
              widestWidth = width
            }
          }
          push(widest)
        } catch {
          /* scanning is best-effort */
        }
        push(document.getElementById('root'))
        var first = document.body !== null ? document.body.firstElementChild : null
        if (first !== null && first.tagName !== 'SCRIPT' && first.tagName !== 'STYLE') push(first)
        return list
      }
      var describeElement = function (element) {
        try {
          var style = window.getComputedStyle(element)
          var rect = element.getBoundingClientRect()
          return {
            tag: element.tagName,
            id: element.id,
            className: typeof element.className === 'string' ? element.className.slice(0, 120) : '',
            display: style.display,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            grid: style.gridTemplateColumns,
            paddingRight: style.paddingRight,
            marginRight: style.marginRight,
          }
        } catch {
          return { tag: 'unknown' }
        }
      }
      var debugEnabled = false
      try {
        debugEnabled = localStorage.getItem('dsh-branch-tree:debug') === '1'
      } catch {
        debugEnabled = false
      }
      var reportDebug = function (payload) {
        if (!debugEnabled) return
        try {
          fetch('/branch-tree/api/debug', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(function () {})
        } catch {
          /* diagnostics never block the UI */
        }
      }
      var activePush = null
      var clearPush = function () {
        if (activePush === null) return
        try {
          if (activePush.kind === 'style') {
            for (var index = 0; index < activePush.entries.length; index += 1) {
              var entry = activePush.entries[index]
              entry.element.style[entry.property] = entry.previous
            }
            var element = activePush.element
            window.setTimeout(function () {
              element.classList.remove('dsh-branch-tree-push-target')
            }, 260)
          }
        } catch {
          /* ignore */
        }
        activePush = null
      }
      var applyPush = function () {
        if (!open) {
          clearPush()
          return
        }
        if (activePush !== null) return
        var width = drawerWidth()
        var before = chatWidth()
        var targets = pushTargets()
        var variants = [
          { name: 'margin-right', apply: function (el) { el.style.marginRight = width + 'px' } },
          { name: 'padding-right', apply: function (el) { el.style.boxSizing = 'border-box'; el.style.paddingRight = width + 'px' } },
          { name: 'width', apply: function (el) { el.style.width = 'calc(100% - ' + width + 'px)' } },
          { name: 'max-width', apply: function (el) { el.style.maxWidth = 'calc(100% - ' + width + 'px)' } },
        ]
        var chosen = null
        var attempts = []
        for (var targetIndex = 0; targetIndex < targets.length && chosen === null; targetIndex += 1) {
          var target = targets[targetIndex]
          for (var variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
            var variant = variants[variantIndex]
            var entries = []
            var record = function (property) {
              entries.push({ element: target, property: property, previous: target.style[property] })
            }
            try {
              if (variant.name === 'padding-right') record('boxSizing')
              record(variant.name === 'margin-right' ? 'marginRight' : variant.name === 'padding-right' ? 'paddingRight' : variant.name === 'width' ? 'width' : 'maxWidth')
              variant.apply(target)
              var after = chatWidth()
              attempts.push({
                target: targetIndex,
                variant: variant.name,
                before: Math.round(before),
                after: Math.round(after),
              })
              if (before > 0 && after > 0 && before - after > Math.max(80, width * 0.25)) {
                chosen = { kind: 'style', element: target, entries: entries }
                break
              }
              for (var revertIndex = 0; revertIndex < entries.length; revertIndex += 1) {
                entries[revertIndex].element.style[entries[revertIndex].property] = entries[revertIndex].previous
              }
            } catch (error) {
              attempts.push({ target: targetIndex, variant: variant.name, error: String(error) })
            }
          }
        }
        if (chosen !== null) {
          activePush = chosen
          try {
            chosen.element.classList.add('dsh-branch-tree-push-target')
          } catch {
            /* ignore */
          }
        } else if (open && before === 0) {
          window.setTimeout(function () {
            if (open && activePush === null) applyPush()
          }, 400)
        }
        reportDebug({
          source: 'dsh-branch-tree',
          event: 'push',
          viewport: { width: window.innerWidth, height: window.innerHeight },
          drawerWidth: width,
          chatBefore: Math.round(before),
          chatAfter: Math.round(chatWidth()),
          chosen: chosen === null ? null : { kind: chosen.kind, target: describeElement(chosen.element) },
          targets: targets.map(describeElement),
          attempts: attempts,
          shellFound: findShell() !== null,
          shellBottom: document.querySelectorAll('[data-shell-bottom]').length,
          rootId: document.getElementById('root') !== null,
        })
      }

      // DSH's own turn-navigation rail (the thin ladder of marks on the right
      // edge of the conversation) is mirrored to the conversation column's LEFT
      // edge. It is a stylesheet override only — no app bundle edits — scoped to
      // the chat's rail slot so previews/tooltips move with it.
      var railStyle = document.createElement('style')
      railStyle.setAttribute('data-dsh-branch-tree-rail', '')
      railStyle.textContent = [
        '.lZzlVW_slot .lZzlVW_frame{right:auto;left:12px}',
        '.lZzlVW_slot .lZzlVW_mark:before{right:auto;left:0;transform-origin:0% 50%}',
        '.lZzlVW_slot .lZzlVW_mark:focus-visible:after{inset:0 auto 0 0}',
        '.lZzlVW_slot .lZzlVW_preview{right:auto;left:calc(100% + 10px)}',
      ].join('')
      document.head.append(railStyle)

      var open = false
      try {
        open = localStorage.getItem(OPEN_KEY) === '1'
      } catch {
        open = false
      }
      var applyOpen = function () {
        host.style.transform = open ? 'translateX(0)' : 'translateX(100%)'
        host.style.pointerEvents = open ? 'auto' : 'none'
        handle.dataset.open = open ? '1' : '0'
        handle.style.background = open ? 'var(--dsw-alias-bg-base,#fff)' : 'var(--dsw-alias-bg-elevated,#fff)'
        applyPush()
      }
      var setOpen = function (next) {
        open = next
        try {
          localStorage.setItem(OPEN_KEY, open ? '1' : '0')
        } catch {
          /* ignore */
        }
        applyOpen()
      }
      applyOpen()
      window.setTimeout(function () {
        if (open) applyPush()
      }, 400)
      window.setTimeout(function () {
        if (open && activePush === null) applyPush()
      }, 1400)
      window.addEventListener('resize', function () {
        if (open) applyPush()
      })

      var post = function (payload) {
        try {
          if (frame.contentWindow !== null) frame.contentWindow.postMessage(payload, location.origin)
        } catch {
          /* the iframe may still be loading */
        }
      }

      var lastCamera = readCamera()
      var postCamera = function () {
        if (lastCamera === null) return
        post({ source: 'dsh-branch-tree', type: 'restore-camera', camera: lastCamera })
      }

      var lastSession
      var postSession = function () {
        if (typeof lastSession !== 'string') return
        post({ source: 'dsh-branch-tree', type: 'session', sessionId: lastSession })
        postCamera()
      }

      var mainSessionId = function () {
        try {
          var list = sessions.list.getSnapshot()
          var ids = Array.isArray(list.ids) ? list.ids : []
          for (var index = 0; index < ids.length; index += 1) {
            var row = list.byId !== undefined ? list.byId[ids[index]] : undefined
            if (row !== undefined && row !== null && ((row.retainedBy && row.retainedBy.mainView) || 0) > 0) {
              return ids[index]
            }
          }
        } catch {
          /* the session store may not be ready yet */
        }
        return undefined
      }

      var syncSession = function () {
        var sessionId = mainSessionId()
        if (sessionId === lastSession) return
        lastSession = sessionId
        if (typeof sessionId !== 'string') return
        postSession()
      }

      /** Fork one round and immediately send the follow-up prompt in the child. */
      var forkRoundAndPrompt = function (request) {
        return (async function () {
          if (sessions === undefined || typeof sessions.fork !== 'function') {
            throw new Error('sessions service is not available')
          }
          // increaseTitle keeps the branch distinguishable in DSH's own lists;
          // a rename failure must not lose the session that already exists.
          var createdId = null
          var childId
          try {
            childId = await sessions.fork({
              sessionId: request.sessionId,
              atSeq: request.seq,
              increaseTitle: true,
              onCreated: function (id) {
                createdId = id
              },
            })
          } catch (error) {
            if (createdId === null) throw error
            childId = createdId
          }
          var reference = null
          try {
            reference = sessions.retain(childId, { source: 'dsh-branch-tree' })
            await reference.ready
            var result = await reference.binding.session.prompt([{ type: 'text', text: request.text }], 'queue')
            if (!result.ok) throw new Error(result.error?.message ?? 'DSH 未接受这条消息')
          } finally {
            if (reference !== null) reference.release()
          }
          if (workspace !== undefined && typeof workspace.openSession === 'function') {
            workspace.openSession(childId)
          }
          return childId
        })()
      }

      var rememberCamera = function (camera) {
        if (camera === null || typeof camera !== 'object' || typeof camera.zoom !== 'number') return
        lastCamera = camera
        try {
          localStorage.setItem(CAMERA_KEY, JSON.stringify(camera))
        } catch {
          /* keep the in-memory copy */
        }
      }

      // ── chat jump (exact event seq; same mechanism as the turn rail) ───────
      var jumpToAnchor = function (sessionId, seq) {
        var deadline = Date.now() + 9000
        var attempt = 0
        var unsubscribe = null
        var done = false

        var release = function () {
          if (unsubscribe !== null) {
            try {
              unsubscribe()
            } catch {
              /* ignore */
            }
            unsubscribe = null
          }
        }

        var finish = function (row) {
          if (done) return
          done = true
          release()
          if (row === null || typeof row.scrollIntoView !== 'function') return
          try {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' })
          } catch {
            try {
              row.scrollIntoView()
            } catch {
              /* ignore */
            }
          }
          try {
            if (document.querySelector('style[data-dsh-branch-tree-jump]') === null) {
              var style = document.createElement('style')
              style.setAttribute('data-dsh-branch-tree-jump', '')
              style.textContent =
                '.dsh-branch-tree-jump-row{outline:2px solid #3478f6 !important;outline-offset:5px;border-radius:10px;transition:outline-color .3s ease}'
              document.head.append(style)
            }
            row.classList.add('dsh-branch-tree-jump-row')
            window.setTimeout(function () {
              row.classList.remove('dsh-branch-tree-jump-row')
            }, 2200)
          } catch {
            /* highlight is cosmetic */
          }
        }

        var tick = function () {
          var binding
          try {
            binding = sessions !== undefined ? sessions.binding(sessionId) : undefined
          } catch {
            binding = undefined
          }
          var chat
          if (binding !== undefined && conversation !== undefined) {
            try {
              chat = conversation.binding(sessionId).target('chat')
            } catch {
              chat = undefined
            }
          }
          if (chat !== undefined && chat !== null) {
            if (unsubscribe === null && typeof chat.subscribe === 'function') {
              try {
                unsubscribe = chat.subscribe(function () {})
              } catch {
                unsubscribe = null
              }
            }
            var snapshot = null
            try {
              snapshot = chat.getSnapshot()
            } catch {
              snapshot = null
            }
            var nodes = snapshot !== null && snapshot !== undefined && snapshot.nodes !== undefined ? snapshot.nodes : null
            var key = null
            if (nodes !== null) {
              for (var node of nodes.values()) {
                if (node.anchorSeq === seq) {
                  key = node.key
                  break
                }
              }
            }
            if (key !== null) {
              var row = document.querySelector('[data-chat-anchor-key="' + CSS.escape(key) + '"]')
              if (row !== null) {
                finish(row)
                return
              }
            } else if (attempt === 0 && binding.session !== undefined && typeof binding.session.loadThrough === 'function') {
              void binding.session.loadThrough(seq).catch(function () {})
            }
          }
          attempt += 1
          if (Date.now() < deadline) window.setTimeout(tick, 250)
          else finish(null)
        }
        window.setTimeout(tick, 220)
      }

      // ── bridge ─────────────────────────────────────────────────────────────
      var onMessage = function (event) {
        if (event.origin !== location.origin) return
        var data = event.data
        if (data === null || typeof data !== 'object' || data.source !== 'dsh-branch-tree') return
        if (data.type === 'request-session') {
          syncSession()
          return
        }
        if (data.type === 'request-camera') {
          postCamera()
          return
        }
        if (data.type === 'camera') {
          rememberCamera(data.camera)
          return
        }
        if (
          data.type === 'fork-round' &&
          typeof data.sessionId === 'string' &&
          data.sessionId !== '' &&
          typeof data.seq === 'number' &&
          Number.isFinite(data.seq) &&
          typeof data.text === 'string' &&
          data.text.trim() !== ''
        ) {
          forkRoundAndPrompt({ sessionId: data.sessionId, seq: data.seq, text: data.text.trim() }).then(
            function (childId) {
              post({ source: 'dsh-branch-tree', type: 'fork-done', sessionId: childId })
            },
            function (error) {
              post({
                source: 'dsh-branch-tree',
                type: 'fork-error',
                message: error instanceof Error ? error.message : String(error),
              })
            },
          )
          return
        }
        if (data.type === 'open-session' && typeof data.sessionId === 'string' && data.sessionId !== '') {
          var navigationError = null
          try {
            if (workspace === undefined || typeof workspace.openSession !== 'function') {
              throw new Error('uiWorkspace service is not available')
            }
            workspace.openSession(data.sessionId)
          } catch (error) {
            navigationError = error instanceof Error ? error.message : String(error)
          }
          if (navigationError !== null) {
            post({ source: 'dsh-branch-tree', type: 'nav-error', message: navigationError })
            return
          }
          if (typeof data.seq === 'number' && Number.isFinite(data.seq)) jumpToAnchor(data.sessionId, data.seq)
        }
      }

      var onLoad = function () {
        postSession()
        postCamera()
      }

      var onHandleClick = function (event) {
        event.stopPropagation()
        setOpen(!open)
      }

      // Click anywhere outside the drawer (main conversation, topbar, empty
      // area) collapses it — EXCEPT the left workspace/session sidebar, where
      // switching workspaces must not close the panel.
      var isLeftSidebarTarget = function (target) {
        if (!(target instanceof Element)) return false
        try {
          if (target.closest('[class*="sidebarCol"]') !== null) return true
          if (target.closest('[data-shell-leading]') !== null) return true
          // Workspace pickers and their dropdown menus are often portaled out
          // of the sidebar column; interacting with them must not close us.
          if (target.closest('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]') !== null) return true
          // The chat input (composer seat + its contenteditable editor): typing
          // or sending must never collapse the panel.
          if (target.closest('[data-composer-seat]') !== null) return true
          if (target.closest('[contenteditable="true"]') !== null) return true
        } catch {
          /* ignore */
        }
        return false
      }
      var onDocumentPointerDown = function (event) {
        if (!open) return
        if (event.target instanceof Node && host.contains(event.target)) return
        if (isLeftSidebarTarget(event.target)) return
        setOpen(false)
      }
      var onKeyDown = function (event) {
        if (event.key === 'Escape' && open) setOpen(false)
      }

      frame.addEventListener('load', onLoad)
      handle.addEventListener('click', onHandleClick)
      window.addEventListener('message', onMessage)
      document.addEventListener('pointerdown', onDocumentPointerDown, true)
      window.addEventListener('keydown', onKeyDown)

      var unsubscribers = []
      try {
        if (sessions !== undefined && sessions.list !== undefined && typeof sessions.list.subscribe === 'function') {
          unsubscribers.push(sessions.list.subscribe(syncSession))
        }
      } catch {
        /* ignore */
      }
      syncSession()
      // The store may not report a main session before the first row exists.
      var bootTimer = window.setInterval(function () {
        syncSession()
        if (typeof lastSession === 'string') {
          window.clearInterval(bootTimer)
          bootTimer = null
        }
      }, 500)

      ctx.effect(function () {
        return function () {
          window.removeEventListener('message', onMessage)
          window.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onDocumentPointerDown, true)
          frame.removeEventListener('load', onLoad)
          handle.removeEventListener('click', onHandleClick)
          if (bootTimer !== null) window.clearInterval(bootTimer)
          for (var unsubscribe of unsubscribers) {
            try {
              unsubscribe()
            } catch {
              /* ignore */
            }
          }
          clearPush()
          host.remove()
          railStyle.remove()
          pushStyle.remove()
        }
      }, 'dsh-branch-tree: persistent drawer')
    }

    module.exports = { inject: inject, apply: apply }
    return module.exports
  },
})
