import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildForest,
  contentText,
  extractLastRound,
  extractRounds,
  extractTitle,
  shortTitle,
  isRuntimeContextText,
  stripSystemPreamble,
  userMessageText,
} from '../lib/extract.js'

const RUNTIME = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nmore text'

function userEvent(seq, text) {
  return { seq, type: 'user/message', time: 1700000000000 + seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function injectedEvent(seq, text, kind = 'time-context') {
  return { seq, type: 'user/message', time: 1700000000000 + seq, data: { source: { kind, form: 'snapshot' }, content: [{ type: 'text', text }] } }
}

function assistantEvent(seq, text) {
  return { seq, type: 'assistant/message', time: 1700000000000 + seq, data: { message: { content: [{ type: 'text', text }] } } }
}

function turnEnd(seq, turn) {
  return { seq, type: 'turn/end', time: 1700000000000 + seq, data: { turn } }
}

function toolEvent(seq) {
  return { seq, type: 'tool-call', time: 1700000000000 + seq, data: { name: 'bash', arguments: '{}' } }
}

test('contentText keeps text, drops tool calls, flattens tool-result text', () => {
  assert.equal(contentText([{ type: 'text', text: 'hello' }, { type: 'tool-call', name: 'bash', arguments: '{}' }]), 'hello')
  assert.equal(contentText([{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }]), 'ok')
  assert.equal(contentText(undefined), '')
})

test('runtime context preamble is detected and skipped', () => {
  assert.equal(isRuntimeContextText(RUNTIME), true)
  assert.equal(isRuntimeContextText('正常问题'), false)
})

test('extractLastRound returns the newest completed round, ignoring tools', () => {
  const events = [
    userEvent(0, RUNTIME),
    userEvent(1, '第一问'),
    toolEvent(2),
    assistantEvent(3, '第一答（中间步骤）'),
    assistantEvent(4, '第一答'),
    toolEvent(5),
    turnEnd(6, 1),
    userEvent(7, '第二问'),
    toolEvent(8),
    assistantEvent(9, '第二答'),
    turnEnd(10, 2),
  ]
  const { round } = extractLastRound(events)
  assert.equal(round.user, '第二问')
  assert.equal(round.assistant, '第二答')
  assert.equal(round.turn, 2)
  assert.equal(round.incomplete, false)
})

test('extractLastRound keeps an in-flight prompt as incomplete', () => {
  const events = [userEvent(0, RUNTIME), userEvent(1, '第一问'), assistantEvent(2, '第一答'), turnEnd(3, 1), userEvent(4, '还没回答的问题')]
  const { round } = extractLastRound(events)
  assert.equal(round.user, '还没回答的问题')
  assert.equal(round.incomplete, true)
  assert.equal(round.assistant, '')
})

test('extractLastRound returns null for empty or context-only logs (blank branch)', () => {
  assert.equal(extractLastRound([]).round, null)
  assert.equal(extractLastRound([userEvent(0, RUNTIME)]).round, null)
})

test('extractTitle prefers session/title, falls back to first user prompt', () => {
  assert.equal(extractTitle([userEvent(0, RUNTIME), userEvent(1, '第一问'), { type: 'session/title', data: { title: '重构按钮' } }]), '重构按钮')
  assert.equal(extractTitle([userEvent(0, RUNTIME), userEvent(1, '做一个分支树插件'), turnEnd(2, 1)]), '做一个分支树插件')
  assert.equal(extractTitle([userEvent(0, RUNTIME)]), '空白分支')
})

test('buildForest nests by parentId and keeps pre-order', () => {
  const forest = buildForest(
    [
      { id: 'a', parentId: 'root' },
      { id: 'a1', parentId: 'a' },
      { id: 'a2', parentId: 'a' },
      { id: 'b', parentId: 'root', activity: 'running' },
      { id: 'b1', parentId: 'b' },
    ],
    'root',
  )
  assert.deepEqual(forest.map((node) => node.id), ['a', 'b'])
  assert.deepEqual(forest[0].children.map((node) => node.id), ['a1', 'a2'])
  assert.deepEqual(forest[1].children.map((node) => node.id), ['b1'])
  assert.equal(forest[1].activity, 'running')
})

test('buildForest tolerates diagnostic rows and unknown parents', () => {
  const forest = buildForest(
    [
      { id: 'x', parentId: 'gone', kind: 'diagnostic' },
      { id: 'y', parentId: 'root' },
    ],
    'root',
  )
  assert.equal(forest.length, 2)
  assert.equal(forest[0].id, 'x')
})

test('userMessageText ignores harness injections, keeps real prompts', () => {
  assert.equal(userMessageText(userEvent(0, '真正的问题')), '真正的问题')
  assert.equal(userMessageText(injectedEvent(1, 'Time sampled while preparing turn 3, step 1: …', 'time-context')), '')
  assert.equal(userMessageText(injectedEvent(2, 'The user switched this session to plan mode.', 'plan-mode')), '')
})

test('extractLastRound skips injected messages after the real prompt', () => {
  const events = [
    userEvent(0, '第一问'),
    assistantEvent(1, '第一答'),
    turnEnd(2, 1),
    userEvent(3, '还没回答的问题'),
    injectedEvent(4, 'Time sampled while preparing turn 2, step 1: …', 'time-context'),
    injectedEvent(5, 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.', 'runtime-context'),
  ]
  const { round } = extractLastRound(events)
  assert.equal(round.user, '还没回答的问题')
  assert.equal(round.incomplete, true)
})

test('system-reminder preambles are stripped from user prompts', () => {
  assert.equal(stripSystemPreamble('<system-reminder>\nrules\n</system-reminder>\n真正任务'), '真正任务')
  assert.equal(stripSystemPreamble('<system-reminder>only plumbing</system-reminder>'), '')
  const event = { seq: 0, type: 'user/message', time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '<system-reminder>\nrules\n</system-reminder>\n降噪没做完吗？' }] } }
  assert.equal(userMessageText(event), '降噪没做完吗？')
})

test('extractRounds returns every round with endSeq for fork mapping', () => {
  const events = [
    userEvent(0, RUNTIME),
    userEvent(1, '第一问'),
    toolEvent(2),
    assistantEvent(3, '第一答中间'),
    assistantEvent(4, '第一答'),
    turnEnd(5, 1),
    userEvent(6, '第二问'),
    assistantEvent(7, '第二答'),
    turnEnd(8, 2),
    userEvent(9, '还在跑的问题'),
  ]
  const rounds = extractRounds(events)
  assert.equal(rounds.length, 3)
  assert.equal(rounds[0].user, '第一问')
  assert.equal(rounds[0].assistant, '第一答')
  assert.equal(rounds[0].turn, 1)
  assert.equal(rounds[0].endSeq, 5)
  assert.equal(rounds[0].userSeq, 1)
  assert.equal(rounds[0].incomplete, false)
  assert.equal(rounds[1].turn, 2)
  assert.equal(rounds[1].endSeq, 8)
  assert.equal(rounds[2].user, '还在跑的问题')
  assert.equal(rounds[2].incomplete, true)
  assert.equal(rounds[2].endSeq, 9)
  assert.equal(rounds[2].userSeq, 9)
})

test('shortTitle takes the first clause and keeps the 10-char budget', () => {
  assert.equal(shortTitle('好，已经很好了。现在你每一个标签上面不是有第 N 轮吗？'), '好，已经很好了')
  assert.equal(shortTitle('你现在这个没有起标题啊。 然后 18 个字太长了'), '你现在这个没有起标…')
  assert.equal([...shortTitle('一二三四五六七八九十十一')].length, 10)
  assert.equal(shortTitle(''), '')
})
