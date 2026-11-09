'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const nativeKey = 'sfexpress_native_requests'
const importedKey = 'sfexpress_native_requests_imported'
const sessionsKey = 'sfexpress_web_sessions'
const exchangeUrl = 'https://ccsp-egmas.sf-express.com/cx-app-member/member/app/user/universalSign'

function sample(token, at = 1) {
  return { at, request: { url: exchangeUrl, method: 'POST', headers: { token, deviceid: 'device-' + token }, body: '{"biz":"sign"}' } }
}

function harness(initial = {}) {
  const prefs = new Map(Object.entries(initial))
  const notifications = []
  const calls = []
  const logs = []
  const context = vm.createContext({
    $prefs: {
      valueForKey: key => prefs.get(key) || null,
      setValueForKey: (value, key) => { prefs.set(key, value); return true }
    },
    $notify: (...args) => notifications.push(args),
    $done: () => {},
    $task: { fetch: async options => { calls.push(options); throw new Error('Unexpected fetch') } },
    console: { log: message => logs.push(message) },
    setTimeout: callback => callback()
  })
  const source = fs.readFileSync(path.join(root, 'scripts/sfexpress.js'), 'utf8')
  const end = source.lastIndexOf('\nmain().catch(')
  assert.ok(end > 0)
  vm.runInContext(source.slice(0, end) + '\nglobalThis.api = { nativeSamples, renewAccounts, main };', context)
  return { context, prefs, notifications, calls, logs, api: context.api }
}

function accounts() {
  return [
    { headers: { cookie: '_login_user_id_=A; session=old-A', signature: 'old-signature' }, label: '账号 A' },
    { headers: { cookie: '_login_user_id_=B; session=old-B', timestamp: 'old-time' }, label: '账号 B' }
  ]
}

function state(list) {
  return JSON.stringify({ accounts: Object.fromEntries(list.map((account, index) => [index ? 'B' : 'A', account])) })
}

function respond(h, identities, rejectedIds = []) {
  h.context.$task.fetch = async options => {
    h.calls.push(options)
    if (options.url === exchangeUrl) {
      const id = identities[options.headers.token]
      if (!id) throw new Error('revoked token: PRIVATE')
      return { body: JSON.stringify({ success: true, obj: { sign: id } }) }
    }
    if (options.url.includes('/share/app/shareRedirect?')) {
      const id = new URL(options.url).searchParams.get('sign')
      return { statusCode: 200, headers: { 'Set-Cookie': [`_login_user_id_=${id}; Path=/`, `session=new-${id}; Path=/`] } }
    }
    if (options.url.endsWith('getTodaySign')) {
      const cookie = options.headers.cookie
      const rejected = rejectedIds.some(id => cookie.includes(`session=new-${id}`))
      return { body: JSON.stringify(rejected ? { success: false, message: 'PRIVATE' } : { success: true, obj: { signed: true, dayCount: 19 } }) }
    }
    if (options.url.endsWith('queryPointTaskAndSignFromES')) {
      return { body: JSON.stringify({ success: true, obj: { taskTitleLevels: [] } }) }
    }
    throw new Error('Unexpected route')
  }
}

async function main() {
  // Local captures, imported captures and bound copies are deduplicated without any writes.
  const local = sample('local', 3)
  const remote = sample('remote', 2)
  const h = harness({ [nativeKey]: JSON.stringify([local]), [importedKey]: JSON.stringify([remote, local]) })
  const before = Array.from(h.prefs)
  const picked = h.api.nativeSamples([{ nativeRequest: local }])
  assert.deepEqual(Array.from(picked, item => item.request.headers.token), ['local', 'remote'])
  assert.deepEqual(Array.from(h.prefs), before)

  // A full local capture history cannot crowd out an older imported account.
  const full = harness({
    [nativeKey]: JSON.stringify(Array.from({ length: 10 }, (_, i) => sample('local-' + i, 100 + i))),
    [importedKey]: JSON.stringify([remote])
  })
  assert.equal(full.api.nativeSamples([]).length, 11)

  // Pasting invalid/hostile data neither leaks it nor prevents use of the local capture.
  for (const raw of ['PRIVATE', '{}', '[null]', JSON.stringify([sample('PRIVATE'), null]),
    JSON.stringify([{ ...remote, request: { ...remote.request, url: 'https://evil.example/' } }]),
    JSON.stringify([{ ...remote, request: { ...remote.request, headers: { token: {} } } }]),
    JSON.stringify(Array.from({ length: 11 }, () => remote)), ' '.repeat(2 * 1024 * 1024) + 'PRIVATE']) {
    const bad = harness({ [nativeKey]: JSON.stringify([local]), [importedKey]: raw })
    assert.equal(bad.api.nativeSamples([]).length, 1)
    assert.equal(bad.notifications.length, 1)
    assert.ok(!JSON.stringify([bad.notifications, bad.logs]).includes('PRIVATE'))
    assert.equal(bad.calls.length, 0)
    assert.equal(bad.prefs.get(importedKey), raw)
  }
  for (const raw of ['', '  ', '[]']) {
    const empty = harness({ [importedKey]: raw })
    assert.equal(empty.api.nativeSamples([]).length, 0)
    assert.equal(empty.notifications.length, 0)
  }

  // Both phones' requests update only the matching account after login validation.
  const list = accounts()
  const two = harness({ [sessionsKey]: state(list), [nativeKey]: JSON.stringify([local]), [importedKey]: JSON.stringify([remote]) })
  respond(two, { local: 'A', remote: 'B' })
  await two.api.renewAccounts(list)
  assert.ok(list[0].headers.cookie.includes('session=new-A'))
  assert.ok(list[1].headers.cookie.includes('session=new-B'))
  assert.equal(list[0].headers.signature, undefined)
  assert.equal(list[1].headers.timestamp, undefined)
  assert.equal(list[1].nativeRequest.request.headers.token, 'remote')
  assert.equal(list[1].authSummary, 'App 换票已更新')
  const saved = JSON.parse(two.prefs.get(sessionsKey))
  assert.equal(saved.accounts.A.nativeRequest.request.headers.token, 'local')
  assert.equal(saved.accounts.B.nativeRequest.request.headers.token, 'remote')
  assert.equal(two.prefs.get(nativeKey), JSON.stringify([local]))
  assert.equal(two.prefs.get(importedKey), JSON.stringify([remote]))

  // Imported data cannot smuggle additional fetch options into the exchange.
  const extra = sample('remote')
  extra.request.opts = { policy: 'PRIVATE', redirection: true }
  extra.request.extra = 'PRIVATE'
  const safe = harness({ [importedKey]: JSON.stringify([extra]) })
  const safeAccounts = accounts()
  respond(safe, { remote: 'B' })
  await safe.api.renewAccounts(safeAccounts)
  assert.equal(safe.calls[0].extra, undefined)
  assert.equal(safe.calls[0].opts.policy, undefined)
  assert.equal(safe.calls[0].opts.redirection, false)

  // Unmatched identities and unverified logins never overwrite existing accounts.
  for (const [id, rejected] of [['C', []], ['B', ['B']]]) {
    const unchanged = accounts()
    const originalHeaders = JSON.stringify(unchanged.map(account => account.headers))
    const guarded = harness({ [sessionsKey]: state(unchanged), [importedKey]: JSON.stringify([remote]) })
    respond(guarded, { remote: id }, rejected)
    await guarded.api.renewAccounts(unchanged)
    assert.equal(JSON.stringify(unchanged.map(account => account.headers)), originalHeaders)
    assert.equal(guarded.prefs.get(sessionsKey), state(accounts()))
  }

  // End-to-end fallback: a revoked imported token still allows both saved Web sessions to sign.
  const fallback = harness({ [sessionsKey]: state(accounts()), [nativeKey]: JSON.stringify([local]), [importedKey]: JSON.stringify([remote]) })
  respond(fallback, { local: 'A' })
  await fallback.api.main()
  assert.equal(fallback.notifications.length, 1)
  assert.equal(fallback.notifications[0][1], '签到成功 2/2 个账号')
  assert.ok(!JSON.stringify([fallback.notifications, fallback.logs]).includes('PRIVATE'))
  assert.ok(fallback.calls.some(call => call.url.endsWith('getTodaySign') && call.headers.cookie.includes('session=old-B')))

  // Malformed imports also leave normal sign-in available.
  const invalid = harness({ [sessionsKey]: state(accounts()), [importedKey]: '{PRIVATE' })
  respond(invalid, {})
  await invalid.api.main()
  assert.equal(invalid.notifications.at(-1)[1], '签到成功 2/2 个账号')

  // The BoxJS input IDs are the actual storage keys, with no embedded credentials.
  const subscription = JSON.parse(fs.readFileSync(path.join(root, 'sfexpress.boxjs.json'), 'utf8'))
  assert.deepEqual(subscription.apps[0].settings.map(setting => setting.id), [nativeKey, importedKey])
  assert.ok(subscription.apps[0].settings.every(setting => setting.val === '' && setting.type === 'textarea'))
  console.log('sfexpress: all tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
