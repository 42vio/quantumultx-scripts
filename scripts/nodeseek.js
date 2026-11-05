/* NodeSeek 每日签到：用浏览器会话和 refract 反爬签名请求签到接口。 */
const SESSION_KEY = 'nodeseek_session'
const PING_URL = 'https://www.nodeseek.com/edge-cgi/ping'
const ATTENDANCE_URL = 'https://www.nodeseek.com/api/attendance?random=true'
const DEFAULT_VERSION = '0.3.34'
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

function headerValue(headers, name) {
  if (!headers) return ''
  const key = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase())
  if (!key) return ''
  const value = headers[key]
  if (!Array.isArray(value)) return String(value == null ? '' : value)
  return value.join(name.toLowerCase() === 'cookie' ? '; ' : ', ')
}

function normalizeCookie(value) {
  return String(value == null ? '' : value).replace(/,\s*(?=[A-Za-z0-9_-]+=)/g, '; ')
}

function cookieValue(cookie, name) {
  const match = normalizeCookie(cookie).match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`))
  return match ? match[1].trim() : ''
}

function randomKey() {
  let key = ''
  for (let i = 0; i < 8; i++) {
    const part = Math.floor(Math.random() * 0x100000000).toString(16)
    key += '00000000'.slice(part.length) + part
  }
  return `${key}-${Date.now()}`
}

function utf8Bytes(value) {
  const bytes = []
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i)
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(++i)
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    }
  }
  return bytes
}

function hex32(value) {
  const text = (value >>> 0).toString(16)
  return '00000000'.slice(text.length) + text
}

function sha1Hex(value) {
  const bytes = utf8Bytes(String(value))
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const high = Math.floor(bitLength / 0x100000000)
  const low = bitLength >>> 0
  bytes.push((high >>> 24) & 255, (high >>> 16) & 255, (high >>> 8) & 255, high & 255)
  bytes.push((low >>> 24) & 255, (low >>> 16) & 255, (low >>> 8) & 255, low & 255)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const words = new Array(80)

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4
      words[i] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]
    }
    for (let i = 16; i < 80; i++) {
      const value = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16]
      words[i] = (value << 1) | (value >>> 31)
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f
      let k
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + words[i]) | 0
      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = temp
    }
    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
  }

  return hex32(h0) + hex32(h1) + hex32(h2) + hex32(h3) + hex32(h4)
}

// 反爬签名：SHA1(method + "\n\n" + url + "\n\n" + UA + "\n\n" + body + "\n\n" + key)
function buildSign(method, url, userAgent, body, key) {
  return sha1Hex([method, url, userAgent, body, key].join('\n\n'))
}

function loadSession() {
  const raw = $prefs.valueForKey(SESSION_KEY)
  if (!raw) return null
  try {
    const session = JSON.parse(raw)
    if (!session || typeof session.cookie !== 'string' || !session.cookie) return null
    session.cookie = normalizeCookie(session.cookie)
    return session
  } catch (_) {
    return null
  }
}

function buildHeaders(session, version, cookies) {
  const headers = {
    'User-Agent': session.userAgent || DEFAULT_UA,
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Origin': 'https://www.nodeseek.com',
    'Referer': `https://www.nodeseek.com/sw.js?v=${version}`,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'refract-version': version
  }
  if (cookies) headers.Cookie = cookies
  return headers
}

async function request(session, method, url, body, key, version, cookies) {
  const headers = buildHeaders(session, version, cookies)
  headers['refract-key'] = key
  headers['refract-sign'] = buildSign(method, url, headers['User-Agent'], body || '', key)
  const options = { url, method, headers }
  if (method !== 'GET' && method !== 'HEAD') options.body = body || ''
  return $task.fetch(options)
}

async function acquireKey(session, version) {
  const seeds = []
  if (session.refractKey) seeds.push(session.refractKey)
  seeds.push(randomKey())
  let status = 0
  const fog = cookieValue(session.cookie, 'fog')
  for (let i = 0; i < seeds.length; i++) {
    const response = await request(session, 'GET', PING_URL, '', seeds[i], version, fog ? `fog=${fog}` : '')
    status = Number(response.statusCode)
    const update = headerValue(response.headers, 'refract-key-update')
    if (update) return update
    if (status === 200) return seeds[i]
  }
  throw new Error(`反爬密钥获取失败（HTTP ${status}）`)
}

async function submit(session) {
  const version = session.refractVersion || DEFAULT_VERSION
  let key = await acquireKey(session, version)
  let response
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await request(session, 'POST', ATTENDANCE_URL, '', key, version, session.cookie)
    const update = headerValue(response.headers, 'refract-key-update')
    if (Number(response.statusCode) !== 403 || !update) return response
    key = update
  }
  return response
}

function classify(response) {
  const status = Number(response.statusCode)
  const body = String(response.body || '')
  const challenge = (status === 403 || status === 503) && (
    headerValue(response.headers, 'cf-mitigated').toLowerCase() === 'challenge' ||
    /Just a moment|challenge-platform|Enable JavaScript and cookies/i.test(body)
  )
  if (challenge) return { kind: 'challenge' }

  let data = null
  try { data = JSON.parse(body) } catch (_) {}
  if (data && data.success === true) return { kind: 'success', data }
  if (data && typeof data.message === 'string') {
    if (/已完成签到|请勿重复|已经签到|已签到/.test(data.message)) return { kind: 'done', message: data.message }
    if (status === 401 || /登录|登陆|未授权|unauthorized/i.test(data.message)) {
      return { kind: 'auth', message: data.message }
    }
    return { kind: 'failed', message: data.message }
  }
  if (status === 401) return { kind: 'auth' }
  return { kind: 'failed', message: `HTTP ${status}` }
}

async function main() {
  const session = loadSession()
  if (!session) {
    $notify('NodeSeek 签到', '尚未获取登录会话', '请在浏览器打开并登录 www.nodeseek.com')
    return { kind: 'missing-session' }
  }

  const response = await submit(session)
  const result = classify(response)
  if (result.kind === 'success') {
    const gain = typeof result.data.gain === 'number' ? result.data.gain : 0
    const current = typeof result.data.current === 'number' ? result.data.current : 0
    $notify('NodeSeek 签到', `签到成功 +${gain} 鸡腿`, `当前 ${current} 鸡腿`)
  } else if (result.kind === 'done') {
    $notify('NodeSeek 签到', '今日已签到', result.message || '请勿重复操作')
  } else if (result.kind === 'auth') {
    $notify('NodeSeek 签到', '登录已失效', '请在浏览器重新登录 www.nodeseek.com')
  } else if (result.kind === 'challenge') {
    $notify('NodeSeek 签到', 'Cloudflare 验证失效', '请在浏览器打开 www.nodeseek.com 后重试')
  } else {
    $notify('NodeSeek 签到', '签到失败', result.message || '未知错误')
  }
  return result
}

if (typeof NODESEEK_TEST === 'undefined') {
  main().catch(error => {
    console.log(`NodeSeek 签到失败：${error.message}`)
    $notify('NodeSeek 签到', '签到失败', error.message)
  }).then(() => $done())
}
