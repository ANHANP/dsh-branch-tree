import assert from 'node:assert/strict'
import test from 'node:test'
import { detectTitleRoute, normalizeGeneratedTitle } from '../index.js'
import { shortTitle } from '../lib/extract.js'

test('normalizeGeneratedTitle strips markdown/quotes and caps at 10 chars', () => {
  assert.equal(normalizeGeneratedTitle('  **分支延伸逻辑**  '), '分支延伸逻辑')
  assert.equal(normalizeGeneratedTitle('“主题与拖拽缩放”。'), '主题与拖拽缩放')
  assert.equal(normalizeGeneratedTitle('一二三四五六七八九十十一'), '一二三四五六七八九…')
  assert.equal(normalizeGeneratedTitle('\n\n  \n'), '')
})

test('detectTitleRoute takes the latest logged model route', () => {
  const events = [
    { type: 'request/header', data: { header: { config: { provider: 'p1', model: 'm1' } } } },
    { type: 'session/title-llm-request', data: { route: { provider: 'deepseek-account', model: 'deepseek-flash' } } },
  ]
  assert.deepEqual(detectTitleRoute(events), { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(detectTitleRoute([]), null)
})

test('shortTitle keeps the 10-char budget including the ellipsis', () => {
  assert.equal([...shortTitle('好，已经很好了。后面还有很多')].length, 7)
  assert.equal([...shortTitle('一二三四五六七八九十')].length, 10)
  assert.equal([...shortTitle('一二三四五六七八九十十一')].length, 10)
})
