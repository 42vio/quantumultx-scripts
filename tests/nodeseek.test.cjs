'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
const PING_URL = 'https://www.nodeseek.com/edge-cgi/ping'
const ATTENDANCE_URL = 'https://www.nodeseek.com/api/attendance?random=true'

function taskContext() {
  const prefs = new Map()
  const notifications = []
  const done = []
  const context = {
    NODESEEK_TEST: true,
    console,
    $prefs: {
      valueForKey(key) { return prefs.has(key) ? prefs.get(key) : null },
      setValueForKey(value, key) { prefs.set(key, value); return true }
    },
    $notify(...args) { notifications.push(args) },
    $done(value) { done.push(value) },
    $task: null
  }
  vm.createContext(context)
  context.__prefs = prefs
  context.__notifications = notifications
  context.__done = done
  return context
}

async function loadTask(context) {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/nodeseek.js'), 'utf8')
  const wrapped = `(async () => {\n${source}\nreturn { sha1Hex, buildSign, acquireKey, submit, classify, main, loadSession, cookieValue, headerValue, normalizeCookie }\n})()`
  return vm.runInContext(wrapped, context, { filename: 'nodeseek.js' })
}

function mockTask(context, responses) {
  const calls = []
  context.$task = {
    fetch: async options => {
      calls.push(options)
      const response = responses.shift()
      if (!response) throw new Error('unexpected fetch')
      return response
    }
  }
  return calls
}

function session(overrides = {}) {
  return Object.assign({
    cookie: 'fog=F; session=SECRET; cf_clearance=C',
    userAgent: UA,
    refractVersion: '0.3.34'
  }, overrides)
}

function runCookie(context) {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/nodeseek.cookie.js'), 'utf8')
  vm.runInContext(`(function() {\n${source}\n})()`, context, { filename: 'nodeseek.cookie.js' })
}

function cookieContext(headers) {
  const prefs = new Map()
  const notifications = []
  const writes = []
  const context = {
    console,
    $request: { headers },
    $prefs: {
      valueForKey(key) { return prefs.has(key) ? prefs.get(key) : null },
      setValueForKey(value, key) {
        prefs.set(key, value)
        writes.push({ key, value })
        return true
      }
    },
    $notify(...args) { notifications.push(args) },
    $done() {}
  }
  vm.createContext(context)
  return { context, prefs, notifications, writes }
}

async function main() {
  const context = taskContext()
  const api = await loadTask(context)
  assert.equal(context.__done.length, 0, '测试模式不应自动执行 $done')

  assert.equal(api.sha1Hex(''), crypto.createHash('sha1').update('').digest('hex'))
  assert.equal(api.sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d')
  assert.equal(api.sha1Hex('中文'), crypto.createHash('sha1').update('中文', 'utf8').digest('hex'))
  assert.equal(
    api.buildSign('POST', ATTENDANCE_URL, UA, '', 'd385f6fa80ceacb697f9a699fc2b906dcc49cd158fe916717f8f55a0920901bf-1793840971008'),
    '668dcb606f6d28b2525c4127d56709745168d242'
  )
  assert.equal(
    api.buildSign('GET', PING_URL, UA, '', 'CHICZkKViFoZmVbIH1Y6'),
    '59e02caa6ae5f4344581cbad62858d83c8fbea9b'
  )
  assert.equal(
    api.buildSign('POST', 'https://www.nodeseek.com/edge-cgi/refract-challenge', UA, '{"endpoint":"https://www.nodeseek.com","challenge":"vjuiMRgRVh/wRy5ITUoAKQ=="}', 'CHICZkKViFoZmVbIH1Y6'),
    '06c4fd54417b0df61b3f45716df21e9ab37a3cf4'
  )

  assert.equal(api.headerValue({ Cookie: ['a=1', 'b=2'] }, 'cookie'), 'a=1; b=2')
  assert.equal(api.headerValue({ 'X-Test': ['a', 'b'] }, 'x-test'), 'a, b')
  assert.equal(api.cookieValue('a=1; fog=F; session=S', 'fog'), 'F')
  assert.equal(api.cookieValue('', 'fog'), '')
  assert.equal(api.normalizeCookie('a=1, session=S, fog=F'), 'a=1; session=S; fog=F')
  assert.equal(api.normalizeCookie('fog=x,y; session=S'), 'fog=x,y; session=S')
  assert.equal(api.cookieValue('a=1, fog=x,y, session=S', 'fog'), 'x,y')
  assert.equal(api.cookieValue('a=1, session=S, fog=F', 'session'), 'S')

  let calls = mockTask(context, [
    { statusCode: 403, headers: { 'Refract-Key-Update': 'K2' }, body: '' }
  ])
  const key = await api.acquireKey(session({ refractKey: 'OLD' }), '0.3.34')
  assert.equal(key, 'K2')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url, PING_URL)
  assert.equal(calls[0].headers.Cookie, 'fog=F')
  assert.equal(calls[0].headers['refract-key'], 'OLD')
  assert.equal(calls[0].headers['refract-sign'], api.buildSign('GET', PING_URL, UA, '', 'OLD'))
  assert.equal(calls[0].headers.Referer, 'https://www.nodeseek.com/sw.js?v=0.3.34')
  assert.equal(calls[0].body, undefined)

  calls = mockTask(context, [
    { statusCode: 500, headers: {}, body: '' },
    { statusCode: 403, headers: { 'refract-key-update': 'K3' }, body: '' }
  ])
  assert.equal(await api.acquireKey(session({ refractKey: 'BAD' }), '0.3.34'), 'K3')
  assert.equal(calls.length, 2)

  calls = mockTask(context, [
    { statusCode: 500, headers: {}, body: '' },
    { statusCode: 500, headers: {}, body: '' }
  ])
  await assert.rejects(api.acquireKey(session(), '0.3.34'), /反爬密钥获取失败/)

  calls = mockTask(context, [
    { statusCode: 403, headers: { 'refract-key-update': 'K2' }, body: '' },
    { statusCode: 200, headers: {}, body: '{"success":true,"message":"今天的签到收益是11个鸡腿","gain":11,"current":70}' }
  ])
  let response = await api.submit(session())
  assert.equal(response.statusCode, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].url, ATTENDANCE_URL)
  assert.equal(calls[1].headers.Cookie, 'fog=F; session=SECRET; cf_clearance=C')
  assert.equal(calls[1].headers['refract-key'], 'K2')
  assert.equal(calls[1].headers['refract-sign'], api.buildSign('POST', ATTENDANCE_URL, UA, '', 'K2'))
  assert.equal(calls[1].body, '')

  calls = mockTask(context, [
    { statusCode: 403, headers: { 'refract-key-update': 'K1' }, body: '' },
    { statusCode: 403, headers: { 'refract-key-update': 'K2' }, body: '' },
    { statusCode: 200, headers: {}, body: '{"success":true,"gain":1,"current":2}' }
  ])
  response = await api.submit(session())
  assert.equal(response.statusCode, 200)
  assert.equal(calls.length, 3)
  assert.equal(calls[2].headers['refract-key'], 'K2')

  assert.deepEqual(
    api.classify({ statusCode: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<html>Just a moment...</html>' }),
    { kind: 'challenge' }
  )
  assert.deepEqual(
    api.classify({ statusCode: 403, headers: {}, body: '<html>Just a moment...</html>' }),
    { kind: 'challenge' }
  )
  assert.deepEqual(
    api.classify({ statusCode: 503, headers: {}, body: '<html>Just a moment...</html>' }),
    { kind: 'challenge' }
  )
  assert.deepEqual(
    api.classify({ statusCode: 401, headers: {}, body: '{"success":false,"message":"请先登录"}' }),
    { kind: 'auth', message: '请先登录' }
  )
  assert.deepEqual(
    api.classify({ statusCode: 500, headers: {}, body: '{"success":false,"message":"今天已完成签到，请勿重复操作"}' }),
    { kind: 'done', message: '今天已完成签到，请勿重复操作' }
  )
  assert.deepEqual(
    api.classify({ statusCode: 500, headers: {}, body: '{"success":false,"message":"签到失败"}' }),
    { kind: 'failed', message: '签到失败' }
  )
  assert.deepEqual(
    api.classify({ statusCode: 500, headers: {}, body: 'oops' }),
    { kind: 'failed', message: 'HTTP 500' }
  )
  const success = api.classify({
    statusCode: 200,
    headers: {},
    body: '{"success":true,"message":"今天的签到收益是11个鸡腿","gain":11,"current":70}'
  })
  assert.equal(success.kind, 'success')
  assert.equal(success.data.gain, 11)

  context.__prefs.set('nodeseek_session', JSON.stringify(session({ cookie: 'fog=F; session=SECRET; cf_clearance=C' })))
  context.__notifications.length = 0
  mockTask(context, [
    { statusCode: 403, headers: { 'refract-key-update': 'K2' }, body: '' },
    { statusCode: 200, headers: {}, body: '{"success":true,"message":"今天的签到收益是11个鸡腿","gain":11,"current":70}' }
  ])
  assert.deepEqual(await api.main(), success)
  assert.deepEqual(context.__notifications[0], ['NodeSeek 签到', '签到成功 +11 鸡腿', '当前 70 鸡腿'])
  assert.equal(JSON.stringify(context.__notifications).includes('SECRET'), false)

  context.__notifications.length = 0
  mockTask(context, [
    { statusCode: 403, headers: { 'refract-key-update': 'K2' }, body: '' },
    { statusCode: 500, headers: {}, body: '{"success":false,"message":"今天已完成签到，请勿重复操作"}' }
  ])
  assert.equal((await api.main()).kind, 'done')
  assert.equal(context.__notifications[0][1], '今日已签到')

  context.__notifications.length = 0
  mockTask(context, [
    { statusCode: 403, headers: { 'refract-key-update': 'K2' }, body: '' },
    { statusCode: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<html>Just a moment...</html>' }
  ])
  assert.equal((await api.main()).kind, 'challenge')
  assert.equal(context.__notifications[0][1], 'Cloudflare 验证失效')

  context.__prefs.clear()
  context.__notifications.length = 0
  assert.equal((await api.main()).kind, 'missing-session')
  assert.equal(context.__notifications[0][1], '尚未获取登录会话')

  const comma = cookieContext({
    cookie: 'colorscheme=light, session=SECRET4, cf_clearance=C4',
    'user-agent': UA,
    'refract-version': '0.3.34'
  })
  runCookie(comma.context)
  assert.equal(
    JSON.parse(comma.writes[0].value).cookie,
    'colorscheme=light; session=SECRET4; cf_clearance=C4'
  )

  context.__prefs.set('nodeseek_session', JSON.stringify(session({ cookie: 'fog=F, session=S, cf_clearance=C' })))
  assert.equal(api.loadSession().cookie, 'fog=F; session=S; cf_clearance=C')

  const first = cookieContext({
    cookie: ['colorscheme=light', 'session=SECRET1', 'cf_clearance=C1'],
    'user-agent': UA,
    'refract-version': '0.3.34',
    'refract-key': 'RK'
  })
  runCookie(first.context)
  assert.equal(first.writes.length, 1)
  const saved = JSON.parse(first.writes[0].value)
  assert.equal(saved.cookie, 'colorscheme=light; session=SECRET1; cf_clearance=C1')
  assert.equal(saved.userAgent, UA)
  assert.equal(saved.refractVersion, '0.3.34')
  assert.equal(saved.refractKey, 'RK')
  assert.deepEqual(first.notifications[0], ['NodeSeek 签到', '登录会话已保存', '现在可以运行签到任务'])
  assert.equal(JSON.stringify(first.notifications).includes('SECRET1'), false)

  first.context.$request.headers = {
    cookie: ['colorscheme=light', 'session=SECRET1', 'cf_clearance=C1'],
    'user-agent': UA,
    'refract-version': '0.3.34',
    'refract-key': 'RK2'
  }
  runCookie(first.context)
  assert.equal(first.writes.length, 1, '相同会话不应重复写偏好')
  assert.equal(first.notifications.length, 1, '相同会话不应重复通知')

  first.context.$request.headers = {
    cookie: ['colorscheme=light', 'session=SECRET2', 'cf_clearance=C2'],
    'user-agent': UA,
    'refract-version': '0.3.34'
  }
  runCookie(first.context)
  assert.equal(first.writes.length, 2)
  assert.equal(first.notifications.length, 2)
  assert.equal(JSON.parse(first.prefs.get('nodeseek_session')).cookie.includes('SECRET2'), true)

  first.context.$request.headers = { cookie: ['colorscheme=light', 'fog=F'] }
  runCookie(first.context)
  assert.equal(first.writes.length, 2, '没有 session 时不应覆盖已有会话')
  assert.equal(first.notifications.length, 2)
  assert.equal(JSON.parse(first.prefs.get('nodeseek_session')).cookie.includes('SECRET2'), true)

  first.context.$request.headers = {
    cookie: ['colorscheme=light', 'session=SECRET2', 'cf_clearance=C2'],
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)',
    'refract-version': '0.3.34'
  }
  runCookie(first.context)
  assert.equal(first.writes.length, 3, 'UA 变化应更新记录')
  assert.equal(first.notifications.length, 2, '仅 UA 变化不应通知')

  const bad = cookieContext({
    cookie: ['session=SECRET3'],
    'user-agent': UA,
    'refract-version': '0.3.34'
  })
  bad.prefs.set('nodeseek_session', '{not json')
  runCookie(bad.context)
  assert.equal(bad.writes.length, 1)
  assert.equal(bad.notifications.length, 1)

  const empty = cookieContext({})
  empty.context.$request = {}
  runCookie(empty.context)
  assert.equal(empty.writes.length, 0)
  assert.equal(empty.notifications.length, 0)

  const auto = taskContext()
  delete auto.NODESEEK_TEST
  auto.__prefs.set('nodeseek_session', JSON.stringify(session()))
  mockTask(auto, [
    { statusCode: 403, headers: { 'refract-key-update': 'K2' }, body: '' },
    { statusCode: 200, headers: {}, body: '{"success":true,"gain":3,"current":9}' }
  ])
  await loadTask(auto)
  for (let i = 0; i < 50 && auto.__done.length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(auto.__done.length, 1, '任务入口应调用一次 $done')
  assert.deepEqual(auto.__notifications[0], ['NodeSeek 签到', '签到成功 +3 鸡腿', '当前 9 鸡腿'])

  console.log('nodeseek tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
