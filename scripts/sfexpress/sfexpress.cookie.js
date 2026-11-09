// Save a separate web session for each account after the sign page confirms login.
const sessionsKey = 'sfexpress_web_sessions'
const legacyKey = 'sfexpress_web_session'
const requestHeaders = $request.headers || {}

function cookieValue(cookie, name) {
  const item = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))
  return item ? item.slice(name.length + 1) : ''
}

function accountId(headers) {
  return cookieValue(headers.cookie || headers.Cookie || '', '_login_user_id_')
}

function accountLabel(headers, id) {
  const mobile = cookieValue(headers.cookie || headers.Cookie || '', '_login_mobile_')
  let digits = mobile
  try { digits = decodeURIComponent(mobile) } catch (_) {}
  digits = digits.replace(/\D/g, '')
  return `账号尾号 ${digits.slice(-4) || id.slice(-4)}`
}

function main() {
  let response
  try { response = JSON.parse($response.body) } catch (_) {}
  if (!response || response.success !== true || !response.obj || typeof response.obj.signed !== 'boolean') {
    $notify('顺丰速运', '会话未更新', '签到页未返回有效登录状态，请退出并重新进入')
    return
  }

  const saved = {}
  for (const name of ['cookie', 'channel', 'deviceid', 'platform', 'syscode', 'user-agent', 'referer', 'signature', 'timestamp']) {
    const actual = Object.keys(requestHeaders).find(header => header.toLowerCase() === name)
    if (actual) saved[name] = requestHeaders[actual]
  }
  const id = accountId(saved)
  if (!id) {
    $notify('顺丰速运', '会话未更新', '请求中缺少账号标识，请重新登录后打开签到页')
    return
  }

  const raw = $prefs.valueForKey(sessionsKey)
  const state = raw ? JSON.parse(raw) : { accounts: {} }
  if (!state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts)) {
    throw new Error('已保存的账号列表格式错误')
  }
  const legacy = $prefs.valueForKey(legacyKey)
  if (legacy) {
    const oldHeaders = JSON.parse(legacy)
    const oldId = accountId(oldHeaders)
    if (oldId && !state.accounts[oldId]) {
      state.accounts[oldId] = { headers: oldHeaders, label: accountLabel(oldHeaders, oldId) }
    }
  }
  const label = accountLabel(saved, id)
  state.accounts[id] = { ...state.accounts[id], headers: saved, label }
  if ($prefs.setValueForKey(JSON.stringify(state), sessionsKey)) {
    $notify('顺丰速运', `${label} 会话已更新`, `已保存 ${Object.keys(state.accounts).length} 个账号`)
  } else {
    $notify('顺丰速运', `${label} 会话保存失败`, '请检查 Quantumult X 设置')
  }
}

try { main() } catch (error) {
  console.log(`顺丰速运会话保存失败：${error.message}`)
  $notify('顺丰速运', '会话保存失败', error.message)
}
$done({})
