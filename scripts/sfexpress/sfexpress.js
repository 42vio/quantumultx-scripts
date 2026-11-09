const base = 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/'
const sessionsKey = 'sfexpress_web_sessions'
const legacyKey = 'sfexpress_web_session'
const signService = '~memberNonactivity~integralSignV2Service~'
const taskService = '~memberNonactivity~integralTaskStrategyService~'
const taskRoute = 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonRoutePost/memberEs/taskRecord/finishTask'

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Authentication only. Keep the original sign-in and daily-task flow below intact.
function storedJson(key, fallback) {
  try { return JSON.parse($prefs.valueForKey(key)) || fallback } catch (_) { return fallback }
}

function nativeHeader(sample, name) {
  const headers = sample.request.headers || {}
  const key = Object.keys(headers).find(key => key.toLowerCase() === name)
  return key === undefined ? '' : headers[key]
}

function validNativeSample(sample) {
  const request = sample && sample.request
  return !!(request &&
    /^https:\/\/ccsp-egmas\.sf-express\.com\/cx-app-member\/member\/app\/user\/universalSign(?:\?[^#]*)?$/.test(request.url) &&
    request.method === 'POST' && typeof request.body === 'string' &&
    request.headers && typeof request.headers === 'object' && !Array.isArray(request.headers) &&
    Object.values(request.headers).every(value => typeof value === 'string') && nativeHeader(sample, 'token'))
}

function importedNativeSamples() {
  const raw = $prefs.valueForKey('sfexpress_native_requests_imported')
  if (!raw || !raw.trim()) return []
  try {
    if (raw.length > 2 * 1024 * 1024) throw new Error('size')
    const samples = JSON.parse(raw)
    if (!Array.isArray(samples) || samples.length > 10 || !samples.every(validNativeSample)) throw new Error('format')
    // Only retain request fields used for exchange; never accept fetch options from pasted data.
    return samples.map(sample => ({
      at: Number.isFinite(sample.at) ? sample.at : 0,
      request: {
        url: sample.request.url, method: sample.request.method,
        headers: sample.request.headers, body: sample.request.body
      }
    }))
  } catch (_) {
    $notify('顺丰速运', '副手机凭据格式错误，已忽略', '请复制“本机 App 换票凭据”的完整 JSON 数组；继续使用其他已保存会话')
    return []
  }
}

function nativeSamples(accounts) {
  const saved = storedJson('sfexpress_native_requests', [])
  const diagnostic = storedJson('sfexpress_auth_diagnostics_v1', { events: [] })
  const candidates = [
    ...(Array.isArray(saved) ? saved : []),
    ...accounts.map(account => account.nativeRequest).filter(Boolean),
    ...(Array.isArray(diagnostic.events) ? diagnostic.events.filter(event => event.route === 'universalSign' && event.phase === 'request') : [])
  ].filter(validNativeSample)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
  const seen = new Set()
  const unique = sample => {
    const identity = JSON.stringify([nativeHeader(sample, 'token'), nativeHeader(sample, 'deviceid'), sample.request.body])
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  }
  const local = candidates.filter(unique).slice(0, 10)
  // Keep room for both phones, even when this phone already has ten newer captures.
  // Deduplicate against the retained local samples, including repeated bound requests.
  seen.clear()
  return [...local, ...importedNativeSamples()]
    .sort((a, b) => (b.at || 0) - (a.at || 0)).filter(unique)
}

function addResponseCookies(jar, headers) {
  const key = Object.keys(headers || {}).find(key => key.toLowerCase() === 'set-cookie')
  const raw = key ? headers[key] : []
  for (const line of (Array.isArray(raw) ? raw : [raw])) {
    // A comma in Expires is not a separator; only split before another name=value.
    for (const item of String(line).split(/,(?=\s*[^\s;,=]+=)/)) {
      const pair = item.split(';')[0].trim()
      const equals = pair.indexOf('=')
      if (equals < 1) continue
      const name = pair.slice(0, equals)
      if (/;\s*max-age\s*=\s*0(?:;|$)/i.test(item)) delete jar[name]
      else jar[name] = pair.slice(equals + 1)
    }
  }
}

async function nativeWebCookie(sample) {
  const headers = {}
  Object.keys(sample.request.headers || {}).forEach(key => {
    if (!/^(host|content-length|connection|accept-encoding|transfer-encoding|:.*)$/i.test(key)) headers[key] = sample.request.headers[key]
  })
  const opts = { redirection: false, 'auto-cookie': false }
  const response = await $task.fetch({ ...sample.request, headers, opts })
  const data = JSON.parse(response.body)
  if (data.success !== true || !data.obj || typeof data.obj.sign !== 'string' || !data.obj.sign) throw new Error('App 换票失败')
  await wait(1000)
  const origin = 'https://mcs-mimp-web.sf-express.com'
  const bizCode = '647@RnlvejM1R3VTSVZ6d3BNaXJxRFpOUVVtQkp0ZnFpNDBKdytobm5TQWxMeHpVUXVrVzVGMHVmTU5BVFA1bXlwcw=='
  let url = `${origin}/mcs-mimp/share/app/shareRedirect?sign=${encodeURIComponent(data.obj.sign)}&source=SFAPP&bizCode=${encodeURIComponent(bizCode)}`
  const jar = {}
  for (let hop = 0; hop < 5; hop++) {
    if (!/^https:\/\/mcs-mimp-web\.sf-express\.com\//.test(url)) throw new Error('Web 跳转域名不符')
    const webHeaders = { 'User-Agent': nativeHeader(sample, 'user-agent') || 'Quantumult X' }
    if (Object.keys(jar).length) webHeaders.Cookie = Object.keys(jar).map(name => `${name}=${jar[name]}`).join('; ')
    const web = await $task.fetch({ url, method: 'GET', headers: webHeaders, opts })
    addResponseCookies(jar, web.headers)
    const cookie = Object.keys(jar).map(name => `${name}=${jar[name]}`).join('; ')
    const status = Number(web.statusCode)
    if (status >= 200 && status < 300) {
      if (!accountId({ cookie })) throw new Error('Web 登录未返回账号标识')
      return cookie
    }
    if (![301, 302, 303, 307, 308].includes(status)) throw new Error('Web 登录响应异常')
    const locationKey = Object.keys(web.headers || {}).find(key => key.toLowerCase() === 'location')
    const location = locationKey ? web.headers[locationKey] : ''
    if (/^https:\/\/mcs-mimp-web\.sf-express\.com\//.test(location)) url = location
    else if (/^\/(?!\/)/.test(location)) url = origin + location
    // A final page can use another host. Validate the cookie without following it.
    else if (accountId({ cookie })) return cookie
    else throw new Error('Web 跳转地址不符')
  }
  throw new Error('Web 跳转次数超限')
}

async function renewAccounts(accounts) {
  const updated = new Set()
  const samples = nativeSamples(accounts)
  for (const sample of samples) {
    try {
      const cookie = await nativeWebCookie(sample)
      await wait(1000)
      const id = accountId({ cookie })
      const account = accounts.find(item => accountId(item.headers) === id)
      if (!account || updated.has(id)) continue
      const headers = { ...account.headers, cookie }
      Object.keys(headers).forEach(key => {
        if (/^(signature|timestamp)$/i.test(key) || (key !== 'cookie' && key.toLowerCase() === 'cookie')) delete headers[key]
      })
      const today = await request(signService + 'getTodaySign', {}, headers)
      if (!today || typeof today.signed !== 'boolean') continue
      // Bind only after the new Web identity matches and its login is confirmed.
      account.headers = headers
      account.nativeRequest = { at: sample.at, request: sample.request }
      account.authSummary = 'App 换票已更新'
      updated.add(id)
      const state = storedJson(sessionsKey, { accounts: {} })
      if (!state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts)) state.accounts = {}
      state.accounts[id] = { ...state.accounts[id], headers, label: account.label, nativeRequest: account.nativeRequest }
      if (!$prefs.setValueForKey(JSON.stringify(state), sessionsKey)) account.authSummary += '（本地保存失败）'
      if (updated.size === accounts.length) break
    } catch (_) {
      // Native responses, redirect URLs and exceptions may contain secrets.
      // Leave the saved Web session usable if native login was revoked.
    }
  }
  for (const account of accounts) {
    if (!account.authSummary && (account.nativeRequest || samples.length)) {
      account.authSummary = account.nativeRequest ? 'App 换票未成功，使用原 Web 会话' : '未取得匹配的 App 会话，使用原 Web 会话'
    }
  }
}

function request(path, body, headers, absolute = false, requireObj = true) {
  return $task.fetch({
    url: absolute ? path : base + path,
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(response => {
    let data
    try {
      data = JSON.parse(response.body)
    } catch (_) {
      throw new Error(`${path.split('/').pop().split('~').pop()} 返回了非 JSON 响应（HTTP ${response.statusCode}）`)
    }
    if (!data || data.success !== true || data.notSuccess === true || (requireObj && data.obj == null)) {
      throw new Error(`${path.split('/').pop().split('~').pop()} 请求失败：${data && (data.errorMessage || data.message || data.msg) || `HTTP ${response.statusCode}`}`)
    }
    return data.obj
  })
}

function accountId(headers) {
  const cookie = headers.cookie || headers.Cookie || ''
  const item = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('_login_user_id_='))
  return item ? item.slice('_login_user_id_='.length) : ''
}

function accountLabel(headers, id) {
  const cookie = headers.cookie || headers.Cookie || ''
  const item = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('_login_mobile_='))
  let mobile = item ? item.slice('_login_mobile_='.length) : ''
  try { mobile = decodeURIComponent(mobile) } catch (_) {}
  const digits = mobile.replace(/\D/g, '')
  return `账号尾号 ${digits.slice(-4) || id.slice(-4)}`
}

function loadAccounts() {
  const raw = $prefs.valueForKey(sessionsKey)
  const state = raw ? JSON.parse(raw) : { accounts: {} }
  if (!state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts)) {
    throw new Error('已保存的账号列表格式错误')
  }
  const accounts = { ...state.accounts }
  const legacy = $prefs.valueForKey(legacyKey)
  if (legacy) {
    const headers = JSON.parse(legacy)
    const id = accountId(headers)
    if (id && !accounts[id]) accounts[id] = { headers, label: accountLabel(headers, id) }
  }
  return Object.values(accounts)
}

async function runAccount(account) {
  const headers = { ...account.headers }
  const label = account.label || '账号'
  let today
  try {
    today = await request(signService + 'getTodaySign', {}, headers)
  } catch (error) {
    if (!headers.signature && !headers.timestamp) throw error
    delete headers.signature
    delete headers.timestamp
    today = await request(signService + 'getTodaySign', {}, headers)
  }
  if (typeof today.signed !== 'boolean') throw new Error('今日签到状态格式已变化')

  let summary
  if (today.signed) {
    summary = `今日已签到，连续 ${today.dayCount || 0} 天`
  } else {
    const result = await request(signService + 'sign', {}, headers)
    if (result.signed !== true) throw new Error('签到接口未确认成功')
    summary = `签到成功，连续 ${result.dayCount || 0} 天`
  }

  await wait(1000)
  let tasks = ''
  try {
    const result = await request(taskService + 'queryPointTaskAndSignFromES', {
      channelType: '1',
      deviceId: headers.deviceId || headers.deviceid || ''
    }, headers)
    if (!Array.isArray(result.taskTitleLevels)) throw new Error('每日任务列表格式已变化')
    const pending = result.taskTitleLevels.filter(task => task.status === 1 || task.status === 2)
    let claimed = 0
    let failed = 0
    for (const task of pending) {
      if (!task.taskCode || task.strategyId == null || !task.taskId) {
        failed++
        continue
      }
      try {
        if (task.status === 2) await request(taskRoute, { taskCode: task.taskCode }, headers, true, false)
        await request(taskService + 'fetchIntegral', {
          strategyId: task.strategyId,
          taskId: task.taskId,
          taskCode: task.taskCode,
          channelType: '1'
        }, headers, false, false)
        claimed++
      } catch (error) {
        failed++
        console.log(`${label} 每日任务 ${task.title || task.taskCode}：${error.message}`)
      }
    }
    tasks = `每日任务领取 ${claimed} 项，未完成 ${failed} 项`
  } catch (error) {
    tasks = `每日任务查询失败：${error.message}`
  }
  return { summary, tasks }
}

async function main() {
  const accounts = loadAccounts()
  if (!accounts.length) throw new Error('缺少会话，请先在顺丰 App 打开签到页')
  await renewAccounts(accounts)
  const lines = []
  let success = 0
  for (const account of accounts) {
    const label = account.label || '账号'
    try {
      const result = await runAccount(account)
      success++
      lines.push(`${label}：${result.summary}${result.tasks ? `｜${result.tasks}` : ''}${account.authSummary ? `｜${account.authSummary}` : ''}`)
    } catch (error) {
      console.log(`顺丰速运 ${label}：${error.message}`)
      lines.push(`${label}：签到失败（${error.message}）${account.authSummary ? `｜${account.authSummary}` : ''}`)
    }
  }
  $notify('顺丰速运', `签到成功 ${success}/${accounts.length} 个账号`, lines.join('\n'))
}

main().catch(error => {
  console.log(`顺丰速运：${error.message}`)
  $notify('顺丰速运', '签到失败', error.message)
}).finally(() => $done())
