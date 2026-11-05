/* 保存 NodeSeek 浏览器会话和反爬版本，供每日签到任务复用。 */
const SESSION_KEY = 'nodeseek_session'

function headerValue(headers, name) {
  if (!headers) return ''
  const key = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase())
  if (!key) return ''
  const value = headers[key]
  if (!Array.isArray(value)) return String(value == null ? '' : value)
  return value.join(name.toLowerCase() === 'cookie' ? '; ' : ', ')
}

// QX 可能把多个 Cookie 头合并成 "a=1, b=2"，统一成 "a=1; b=2" 再保存。
function normalizeCookie(value) {
  return String(value == null ? '' : value).replace(/,\s*(?=[A-Za-z0-9_-]+=)/g, '; ')
}

function sessionToken(cookie) {
  const match = normalizeCookie(cookie).match(/(?:^|;)\s*session=([^;]+)/)
  return match ? match[1].trim() : ''
}

try {
  const headers = $request.headers || {}
  const cookie = normalizeCookie(headerValue(headers, 'cookie'))
  const token = sessionToken(cookie)
  if (token) {
    const record = {
      cookie,
      userAgent: headerValue(headers, 'user-agent'),
      refractKey: headerValue(headers, 'refract-key'),
      refractVersion: headerValue(headers, 'refract-version'),
      updatedAt: Date.now()
    }
    let previous = null
    const raw = $prefs.valueForKey(SESSION_KEY)
    if (raw) {
      try { previous = JSON.parse(raw) } catch (_) {}
    }
    const changed = !previous || previous.cookie !== record.cookie ||
      previous.userAgent !== record.userAgent || previous.refractVersion !== record.refractVersion
    if (changed) {
      const saved = $prefs.setValueForKey(JSON.stringify(record), SESSION_KEY)
      if (saved && (!previous || sessionToken(previous.cookie) !== token)) {
        $notify('NodeSeek 签到', '登录会话已保存', '现在可以运行签到任务')
      }
    }
  }
} catch (error) {
  console.log(`NodeSeek 会话保存失败：${error.message}`)
}
$done({})
