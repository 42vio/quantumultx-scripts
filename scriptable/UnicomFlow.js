// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: chart-bar;
/*
联通流量 · 小号 / 中号（使用 DmYY 配置菜单）
1. QX 开启现有 dompling 联通重写和 BoxJS。
2. 联通官方 App 首页 → 流量，收到 Cookie 写入成功通知。
3. 将 DmYY.js 放入同一 Scriptable 脚本目录，再新建脚本粘贴本文件。
4. 运行后在 DmYY 菜单中预览、配置和刷新数据，再添加桌面组件。
直接读取 http://boxjs.net/query/data/@YaYa_10010.cookie。
Cookie 只在请求时读取，不写入文件、不打印日志；文件只保存流量快照。
支持黑色/白色主题。可识别共享与非共享通用套餐时分开显示，否则显示通用/定向。
大数字为已用，下方为总量及已用百分比。明细未返回时显示 --。
中号图为两次查询之间的用量增量，记在本次采样小时，不是运营商小时账单。
iOS 决定实际刷新时刻；首次运行无历史，跨月、套餐变化或计数回退时重建基线。
接口字段参考：联通套餐查询接口及 ChinaTelecomOperators/ChinaUnicom 公开实现；
流量和图表为独立实现，菜单依赖 DmYY.js；不会复用旧组件的 Cookie 设置。
*/

// UnicomFlow Scriptable Widget
const UF_VERSION = '1.0.5';
const UF_UPDATE_URL = 'https://raw.githubusercontent.com/42vio/quantumultx-scripts/main/scriptable/UnicomFlow.js';

const UF = {
  boxjs: 'http://boxjs.net',
  cookieKey: '@YaYa_10010.cookie',
  endpoint: 'https://mxx.client.10010.com/servicequerybusiness/operationservice/queryOcsPackageFlowLeftContentRevisedInJune',
  // 联通 App 自身也是 POST 这份表单；不带参数时服务端会省略逐卡明细字段。
  form: 'duanlianjieabc=&channelCode=&serviceType=&saleChannel=&externalSources=&contactCode=&ticket=&ticketPhone=&ticketChannel=&mobile1=&language=chinese',
  refreshMinutes: 30,
  folder: 'UnicomFlow',
  bg: '1C1C1E', text: 'F5F5F7', muted: 'A4A4AA', track: '454548',
  blue: '0A94FF', purple: '8A73FF', warning: 'FFD166', gridMajor: '38383C', gridMinor: '27272B',
};
const UF_DEFAULTS = { ...UF };

const UF_THEMES = {
  黑色: { bg: '1C1C1E', text: 'F5F5F7', muted: 'A4A4AA', track: '454548', blue: '0A94FF', purple: '8A73FF', warning: 'FFD166', gridMajor: '38383C', gridMinor: '27272B' },
  白色: { bg: 'FFFFFF', text: '1C1C1E', muted: '686870', track: 'E5E5EA', blue: '007AFF', purple: '7552D9', warning: '946200', gridMajor: 'D1D1D6', gridMinor: 'F0F0F3' },
};

function applyTheme(settings = {}) {
  const light = settings.theme === '白色';
  const palette = UF_THEMES[light ? '白色' : '黑色'];
  Object.assign(UF, palette);
  const keys = { CardColor: 'bg', NumberColor: 'text', FlowBarColor: 'blue', ChartBarColor: 'purple' };
  for (const [key, target] of Object.entries(keys)) {
    const legacy = key[0].toLowerCase() + key.slice(1);
    const value = String(settings[(light ? 'white' : 'black') + key] || (!light && settings[legacy]) || '').replace(/^#/, '');
    if (/^[a-f0-9]{6}$/i.test(value)) UF[target] = value;
  }
}

function sumPackages(list) {
  if (!list.length) return null;
  return {
    used: list.reduce((sum, p) => sum + p.used, 0),
    total: list.some(p => p.unlimited) ? null : list.reduce((sum, p) => sum + p.total, 0),
    count: list.length,
  };
}

function displayMetrics(data, mode = '统一显示') {
  if (mode === '主副卡分开显示') {
    const members = [...(data.members || [])].sort((a, b) => {
      const rank = m => m.role === '主卡' ? 0 : m.current ? 1 : 2;
      return rank(a) - rank(b) || a.id.localeCompare(b.id);
    });
    const metric = member => {
      if (!member) return null;
      const records = member.records.filter(r => r.used != null && !r.conflict);
      return records.length ? { used: records.reduce((sum, r) => sum + r.used, 0), total: null, detail: '已返回明细合计' } : null;
    };
    const label = (member, fallback) => member ? `${member.role}·${member.phone.slice(-4)}` : fallback;
    return { left: metric(members[0]), right: metric(members[1]), leftLabel: label(members[0], '主卡明细'),
      rightLabel: label(members[1], '副卡明细'), omitted: members.length > 2, perMember: true,
      note: members.length ? members.length > 2 ? '另有成员 · 菜单查看全部' : '仅含已返回明细 · 非完整账单' : '未返回逐卡明细 · 点击查看' };
  }
  const general = data.packages.filter(p => p.category === 'general');
  const shared = general.filter(p => p.shared === true);
  const exclusive = general.filter(p => p.shared === false);
  // 能识别两种套餐时分开显示；不根据 120GB/80GB 数值猜测套餐归属。
  if (shared.length && exclusive.length) {
    const omitted = data.packages.some(p => p.category !== 'ignore' && (p.category !== 'general' || p.shared == null));
    return { left: sumPackages(shared), right: sumPackages(exclusive), leftLabel: '共享通用', rightLabel: '非共享通用', omitted };
  }
  return { left: data.categories.general, right: data.categories.directed, leftLabel: '通用', rightLabel: '定向', omitted: false };
}

function finiteNumber(value) {
  if (value == null || typeof value === 'boolean') return null;
  const s = String(value).trim().replace(/,/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// RevisedInJune 的 total/use/remain 是 MB；明确带单位的字段按单位换算。
function megabytes(value, unit) {
  const match = typeof value === 'string'
    ? value.trim().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB|K|M|G|T)$/i) : null;
  const n = finiteNumber(match ? match[1] : value);
  if (n == null) return null;
  const u = String(match ? match[2] : unit || 'MB').toUpperCase();
  const multiplier = { K: 1 / 1024, KB: 1 / 1024, M: 1, MB: 1, G: 1024, GB: 1024, T: 1048576, TB: 1048576 }[u];
  return multiplier == null ? null : n * multiplier;
}

function formatMB(value) {
  if (value == null || !Number.isFinite(value)) return '--';
  const scale = value >= 1048576 ? [1048576, 'TB'] : value >= 1024 ? [1024, 'GB'] : [1, 'MB'];
  return `${(value / scale[0]).toFixed(2).replace(/(\.\d)0$/, '$1')}${scale[1]}`;
}

function dayKey(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sessionTag(cookie) {
  // 非可逆的会话指纹，仅用来阻止不同 Cookie 的历史混合；不保存 Cookie。
  let h = 2166136261;
  for (let i = 0; i < cookie.length; i++) h = Math.imul(h ^ cookie.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

// 成员字段在不同省份、不同版本的响应里命名不一致，按“号码 + 用量”的结构识别，而不只认固定字段名。
const UF_CARD_KEYS = ['serialNumber', 'userMobile', 'usernumber', 'number', 'mobile', 'phone', 'secretNumber',
  'viceCardNo', 'viceCardNumber', 'cardNo', 'subscriberNo', 'servNumber', 'tel'];
const UF_USE_KEYS = ['use', 'used', 'usage', 'usedFlow', 'useFlow', 'flowUse', 'usedValue', 'useValue'];

function cardId(row) {
  for (const key of UF_CARD_KEYS) {
    const value = row[key] == null ? '' : String(row[key]).trim();
    if (/^(?:\d{7,}|[\d*]{3,}\*[\d*]*)$/.test(value)) return value;
  }
  return '';
}

function usageOf(row, unit) {
  for (const key of UF_USE_KEYS) {
    if (row[key] == null) continue;
    const value = megabytes(row[key], row.unit || unit);
    if (value != null) return value;
  }
  return null;
}

function memberLists(record, consumed) {
  if (!record || typeof record !== 'object') return [];
  const lists = [];
  for (const [key, value] of Object.entries(record)) {
    if (!/^vicecardl(?:ist|its)$/i.test(key) || !Array.isArray(value)) continue;
    if (consumed) consumed.add(value);
    lists.push(value);
  }
  return lists.flat();
}

// 兜底：找出响应中任何“号码 + 用量”的数组，兼容未预料的字段名；已被套餐解析消费的数组不重复使用。
function memberSources(body, consumed) {
  const found = [];
  let visited = 0;
  const walk = (value, path, depth) => {
    if (!value || typeof value !== 'object' || depth > 8 || visited++ > 20000) return;
    if (Array.isArray(value)) {
      const rows = value.length && !consumed.has(value)
        && value.every(item => item && typeof item === 'object' && !Array.isArray(item) && cardId(item))
        ? value.map(row => ({ row, used: usageOf(row, row.unit) })).filter(item => item.used != null) : [];
      if (rows.length) found.push({ path, rows });
      value.slice(0, 40).forEach(item => walk(item, path + '[]', depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, path ? path + '.' + key : key, depth + 1);
  };
  walk(body, '', 0);
  return found;
}

// 只输出字段路径、数组长度和元素字段名，不包含手机号、Cookie 或任何字段值。
function memberStructure(body) {
  const lines = [], seen = new Set(), max = 120;
  const safe = key => /^[a-zA-Z_$][a-zA-Z0-9_$]{0,39}$/.test(key) ? key : '[字段]';
  const push = line => { if (!seen.has(line) && lines.length < max) { seen.add(line); lines.push(line); } };
  const walk = (value, path, depth) => {
    if (!value || typeof value !== 'object' || depth > 6 || lines.length >= max) return;
    if (Array.isArray(value)) {
      push(`${path || '根'}: 数组，${value.length} 项`);
      const sample = value.find(item => item && typeof item === 'object' && !Array.isArray(item));
      if (sample) push(`${path || '根'}[]: ${Object.keys(sample).slice(0, 16).map(safe).join(', ')}`);
      value.slice(0, 2).forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object') walk(child, path ? `${path}.${safe(key)}` : safe(key), depth + 1);
    }
  };
  walk(body, '', 0);
  const sources = memberSources(body, new Set());
  const candidate = sources.length ? sources.map(s => `${s.path}: ${s.rows.length} 条含号码与用量`)
    : ['未发现含“号码 + 用量”的数组'];
  return ['仅含字段路径、数组长度与元素字段名，不含手机号、Cookie 或字段值。',
    '候选成员明细：', ...candidate, '', '结构：', ...(lines.length ? lines : ['未发现相关字段'])].join('\n');
}

// 真实响应里 numberFlag('1'=副卡) 与 viceCardflag('1'=主卡) 互补；两者冲突时不猜角色。
function roleOf(raw) {
  const text = String(raw.role || raw.cardType || raw.roleName || raw.cardRole || '').toLowerCase();
  if (/主卡|primary|main/.test(text)) return '主卡';
  if (/副卡|secondary|vice/.test(text)) return '副卡';
  const signals = [];
  if (raw.numberFlag != null && String(raw.numberFlag) !== '') signals.push(String(raw.numberFlag) === '1' ? '副卡' : '主卡');
  if (raw.viceCardflag != null && String(raw.viceCardflag) !== '') signals.push(String(raw.viceCardflag) === '0' ? '副卡' : '主卡');
  return signals.length && signals.every(role => role === signals[0]) ? signals[0] : '成员卡';
}

function memberRows(rows, unit) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const phone = cardId(raw);
    if (!phone) return [];
    const masked = phone.length >= 7 ? phone.slice(0, 3) + '****' + phone.slice(-4) : '****' + phone.slice(-2);
    // 当前登录卡不等同于主卡，缺失角色时只显示成员卡。
    return [{ id: sessionTag(phone), phone: masked, role: roleOf(raw), current: String(raw.currentLoginFlag) === '1', used: usageOf(raw, unit) }];
  });
}

function summarizeMembers(body, packages, consumed) {
  const members = new Map();
  const get = row => {
    if (!members.has(row.id)) members.set(row.id, { id: row.id, phone: row.phone, role: row.role, current: row.current, records: [] });
    const member = members.get(row.id);
    if (member.role === '成员卡' && !member.roleConflict) member.role = row.role;
    else if (row.role !== '成员卡' && member.role !== row.role) { member.role = '成员卡'; member.roleConflict = true; }
    member.current = member.current || row.current;
    return member;
  };
  const attach = (pkg, rows) => {
    for (const row of rows) {
      if (!(pkg.members || []).some(item => item.id === row.id && item.used === row.used)) (pkg.members = pkg.members || []).push(row);
    }
  };
  for (const row of memberRows(memberLists(body, consumed))) get(row);
  // shareData 里能对上已知套餐的逐卡明细补到该套餐名下；只补成员，不改套餐池额度。
  if (body.shareData && Array.isArray(body.shareData.details)) {
    for (const item of body.shareData.details) {
      if (!item || typeof item !== 'object') continue;
      const pkg = packages.find(p => p.id === packageId(item));
      if (pkg) attach(pkg, memberRows(memberLists(item, consumed), item.unit));
    }
  }
  for (const pkg of packages.filter(p => p.category !== 'ignore')) {
    for (const row of pkg.members || []) {
      const member = get(row);
      const existing = member.records.find(record => record.packageId === pkg.id);
      if (existing) {
        if (existing.used !== row.used) { existing.used = null; existing.conflict = true; }
      } else member.records.push({ packageId: pkg.id, name: pkg.name, used: row.used });
    }
  }
  // 字段名未预料的成员数组：只补充这张卡的明细，不参与套餐池合计。
  for (const source of memberSources(body, consumed)) {
    const label = source.path.split('.').slice(-2).join('.');
    for (const { row, used } of source.rows) {
      const [normalized] = memberRows([row]);
      if (!normalized) continue;
      const member = get({ ...normalized, used });
      // 同一张卡同值的镜像数组（如 shareData.viceCardList）不重复累加。
      if (member.records.some(record => record.used === used)) continue;
      member.records.push({ packageId: 'member:' + source.path, name: `成员明细 · ${label}`, used });
    }
  }
  return [...members.values()];
}

function packageId(item) {
  const name = [item.feePolicyName, item.addUpItemName].filter(Boolean).join(' · ') || '未命名流量包';
  return JSON.stringify([item.feePolicyId || name, item.addupItemCode || '', item.endDate || item.endXsbDate || '']);
}

function parsePackages(body, overrides = {}) {
  if (!body || String(body.code) !== '0000') {
    throw new Error('联通未返回套餐数据，请重新获取 Cookie 或稍后重试');
  }
  const packages = [], warnings = [], seen = new Map(), memberArrays = new Set();
  const roots = ['resources', 'unshared', 'rzbresources', 'mlresources'];
  for (const root of roots) {
    if (!Array.isArray(body[root])) continue;
    for (const group of body[root]) {
      const type = String(group.type || '');
      if (/voice|sms/i.test(type)) continue;
      if (!type || !/flow/i.test(type)) {
        warnings.push('有未识别的资源类型');
        continue;
      }
      if (!Array.isArray(group.details)) continue;
      for (const item of group.details) {
        const name = [item.feePolicyName, item.addUpItemName].filter(Boolean).join(' · ') || '未命名流量包';
        const total = megabytes(item.total, item.unit);
        let used = megabytes(item.use, item.unit);
        const remaining = megabytes(item.remain, item.unit);
        const unlimited = String(item.limited) === '1';
        if (used === 0) {
          const over = megabytes(item.xexceedvalue, item.unit);
          if (over != null && over > 0) used = over;
        }
        if (used == null && !unlimited && total != null && remaining != null && total >= remaining) used = total - remaining;
        if (used == null || (!unlimited && total == null)) {
          warnings.push('有流量包数值无法识别');
          continue;
        }
        // 共享包保持整个套餐池的口径，与 total/remain 一致，不混用某张副卡的 use。
        const id = packageId(item);
        const signature = JSON.stringify([used, total, remaining, unlimited]);
        if (seen.has(id)) {
          if (seen.get(id) !== signature) throw new Error('同一套餐出现不同数值，暂不汇总，请在联通 App 核对共享套餐');
          packages.find(pkg => pkg.id === id).members.push(...memberRows(memberLists(item, memberArrays), item.unit));
          continue;
        }
        seen.set(id, signature);
        const directed = root === 'mlresources' || String(item.addupItemCode) === '40008' || /定向|专享免费|免流|畅视/.test(name);
        // 日租/套外不并入月套餐，避免在统计上混合不同计费口径。
        let category = root === 'rzbresources' ? 'ignore' : directed ? 'directed' : 'general';
        // unshared 元数据优先；针对已知套餐名称识别，不固定套餐额度或当前用量。
        let shared = root === 'unshared' || /unshared/i.test(type) || /非共享|政企0元80GB国内通用流量包/i.test(name) ? false
          : /共享|5G畅爽冰激凌199元/.test(name) ? true : null;
        if (['general', 'directed', 'ignore'].includes(overrides[id])) category = overrides[id];
        if (['shared', 'exclusive'].includes(overrides[id])) { category = 'general'; shared = overrides[id] === 'shared'; }
        packages.push({ id, name, category, shared, used, total: unlimited ? null : total, remaining, unlimited, members: memberRows(memberLists(item, memberArrays), item.unit) });
      }
    }
  }
  if (!packages.length) throw new Error('未识别到流量套餐明细，请查看“连接检查”并反馈结构');
  const categories = {};
  for (const category of ['general', 'directed']) {
    const list = packages.filter(p => p.category === category);
    categories[category] = list.length ? {
      used: list.reduce((sum, p) => sum + p.used, 0),
      total: list.some(p => p.unlimited) ? null : list.reduce((sum, p) => sum + p.total, 0),
      count: list.length,
    } : null;
  }
  if (!categories.general && !categories.directed) throw new Error('当前流量包均已排除，请在“套餐分类”中选择要显示的套餐');
  return { categories, packages, members: summarizeMembers(body, packages, memberArrays), memberReport: memberStructure(body), warnings: [...new Set(warnings)] };
}

function snapshotSignature(packages) {
  return JSON.stringify(packages.filter(p => p.category !== 'ignore')
    .map(p => [p.id, p.category, p.shared == null ? null : p.shared, p.total]).sort((a, b) => a[0].localeCompare(b[0])));
}

function updateHistory(previous, sample) {
  const old = previous && previous.version === 1 && previous.session === sample.session ? previous : {};
  let events = Array.isArray(old.events) ? old.events.filter(e =>
    Number.isFinite(e.at) && e.at <= sample.at && e.at >= sample.at - 7 * 86400000) : [];
  const prev = old.last;
  if (prev && sample.at <= prev.at) return old;
  let note = '正在积累数据';
  const signature = snapshotSignature(sample.packages);
  if (prev && sample.at > prev.at && dayKey(prev.at).slice(0, 7) === dayKey(sample.at).slice(0, 7)
    && prev.signature === signature) {
    const lastUse = new Map(prev.packages.map(p => [p.id, p.used]));
    let delta = 0, valid = true;
    for (const p of sample.packages.filter(p => p.category !== 'ignore')) {
      const before = lastUse.get(p.id);
      if (!Number.isFinite(before) || p.used < before) { valid = false; break; }
      delta += p.used - before;
    }
    if (valid) {
      // 跨午夜的区间不能归为“今日”用量；不拆分或插值。
      if (dayKey(prev.at) === dayKey(sample.at)) events.push({ from: prev.at, at: sample.at, mb: delta });
      note = '今日区间增量 · 按采样时刻';
    } else { events = []; note = '计数回退，重新积累'; }
  } else if (prev) { events = []; note = '套餐或月份变化，重新积累'; }
  return { version: 1, session: sample.session, events, note,
    last: { at: sample.at, signature, packages: sample.packages }, data: sample };
}

function todayBuckets(history, at) {
  const buckets = Array.from({ length: 24 }, () => ({ mb: 0, samples: 0 }));
  for (const event of history.events || []) {
    if (dayKey(event.at) !== dayKey(at) || dayKey(event.from) !== dayKey(at)) continue;
    const bucket = buckets[new Date(event.at).getHours()];
    bucket.mb += event.mb;
    bucket.samples++;
  }
  return buckets;
}

// ---- 手机端存储与请求 ----
function storage() {
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.documentsDirectory(), UF.folder);
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  return {
    read(name, fallback) {
      const path = fm.joinPath(dir, name + '.json');
      try { return fm.fileExists(path) ? JSON.parse(fm.readString(path)) : fallback; }
      catch (_) { return fallback; }
    },
    write(name, value) { fm.writeString(fm.joinPath(dir, name + '.json'), JSON.stringify(value)); },
    clear() { const path = fm.joinPath(dir, 'history.json'); if (fm.fileExists(path)) fm.remove(path); },
  };
}

async function readCookie() {
  const req = new Request(UF.boxjs + '/query/data/' + UF.cookieKey);
  req.timeoutInterval = 5;
  let result;
  try { result = await req.loadJSON(); }
  catch (_) { throw new Error(`无法读取 BoxJS，请保持 QX 开启，并确认 Safari 能打开 ${UF.boxjs}`); }
  const cookie = result && typeof result.val === 'string' ? result.val.trim() : '';
  if (!cookie || !/JSESSIONID=/i.test(cookie)) throw new Error('QX 中没有有效的联通 Cookie，请打开联通 App 首页 → 流量查询');
  return cookie;
}

async function postData(cookie, form) {
  const req = new Request(UF.endpoint);
  req.method = 'POST';
  req.headers = {
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'https://imgxx.client.10010.com',
    Referer: 'https://imgxx.client.10010.com/',
  };
  if (form) req.body = form;
  req.timeoutInterval = 12;
  let raw;
  try { raw = await req.loadString(); }
  catch (_) { throw new Error('联通明细接口暂时不可用，请检查网络后重试'); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (_) { parsed = null; }
  // 过期 Cookie 时接口返回纯文本 999999，JSON.parse 会成功得到一个数字，同样按非 JSON 处理。
  return parsed && typeof parsed === 'object' ? parsed : { code: 'NON_JSON', raw: String(raw).slice(0, 40) };
}

async function fetchData(cookie, overrides) {
  // 先按 App 自身的表单请求（逐卡明细依赖这份参数）；失败时退回不带表单的旧请求。
  let error = null;
  for (const form of [UF.form, '']) {
    const body = await postData(cookie, form);
    if (body.code === 'NON_JSON') {
      error = new Error(/^\d+$/.test(body.raw.trim()) ? 'Cookie 可能已失效，请打开联通 App 首页 → 流量查询后重试'
        : '联通明细接口返回了非 JSON 内容，请在“连接检查”查看');
      continue;
    }
    try { return parsePackages(body, overrides); }
    catch (parseError) { error = parseError; }
  }
  throw error || new Error('联通明细接口暂时不可用，请稍后重试');
}

async function refresh(store) {
  const cookie = await readCookie();
  const session = sessionTag(cookie);
  const previous = store.read('history', null);
  if (previous && previous.session !== session) store.clear();
  const data = await fetchData(cookie, store.read('categories', {}));
  const sample = { ...data, at: Date.now(), session };
  const history = updateHistory(store.read('history', null), sample);
  store.write('history', history);
  return { history, stale: false, error: '' };
}

// ---- 所有布局均由 Scriptable 原生绘图生成 ----
function text(ctx, value, x, y, width, height, size, color = UF.text, mono = false, centered = false) {
  ctx.setTextColor(new Color(color));
  ctx.setFont(mono ? Font.regularMonospacedSystemFont(size) : Font.mediumSystemFont(size));
  if (centered) ctx.setTextAlignedCenter(); else ctx.setTextAlignedLeft();
  ctx.drawTextInRect(value, new Rect(x, y, width, height));
}

function roundedRect(ctx, x, y, w, h, radius, color) {
  if (w <= 0 || h <= 0) return;
  const path = new Path();
  path.addRoundedRect(new Rect(x, y, w, h), radius, radius);
  ctx.setFillColor(new Color(color));
  ctx.addPath(path);
  ctx.fillPath();
}

function drawMetric(ctx, metric, label, x, y, width, compact) {
  const title = label.length > 2 ? label : '数据流量·' + label;
  text(ctx, title, x, y, width, 15, compact ? 10 : 11);
  const barY = y + (compact ? 16 : 20), barH = compact ? 36 : 38;
  roundedRect(ctx, x, barY, 6, barH, 3, UF.track);
  const ratio = metric && metric.total > 0 ? Math.min(1, Math.max(0, metric.used / metric.total)) : null;
  if (ratio != null && ratio > 0) roundedRect(ctx, x, barY + barH * (1 - ratio), 6, barH * ratio, 3, UF.blue);
  const primary = formatMB(metric && metric.used);
  const base = compact ? 22 : 25;
  const size = Math.min(base, (width - 11) / Math.max(1, primary.length * 0.62));
  text(ctx, primary, x + 11, y + (compact ? 13 : 17), width - 11, 31, size, UF.text, true);
  let detail = '未返回明细';
  if (metric) detail = metric.detail || (metric.total == null ? '不限量' : `${formatMB(metric.total)} (${metric.total > 0 ? Math.round(metric.used / metric.total * 100) : '--'}%)`);
  const detailSize = Math.min(compact ? 12 : 13, (width - 11) / Math.max(1, detail.length * 0.57));
  text(ctx, detail, x + 11, y + (compact ? 39 : 43), width - 11, 16, detailSize, metric ? UF.text : UF.muted, true);
}

function renderImage(result, medium, width, height) {
  // 统一为 158 点设计高度，再随组件尺寸缩放，避免小屏沿用固定坐标而挤入圆角。
  width = Math.round(width * 158 / height);
  height = 158;
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.respectScreenScale = true;
  ctx.opaque = true;
  ctx.setFillColor(new Color(UF.bg));
  ctx.fillRect(new Rect(0, 0, width, height));
  const data = result.history.data, pad = 20;
  const metrics = displayMetrics(data, UF.displayMode);
  if (medium) {
    const col = (width - 2 * pad - 20) / 2;
    drawMetric(ctx, metrics.left, metrics.leftLabel, pad, 16, col, false);
    drawMetric(ctx, metrics.right, metrics.rightLabel, pad + col + 20, 16, col, false);
    const buckets = todayBuckets(result.history, Date.now());
    const chartX = pad, chartY = 102, chartW = width - 2 * pad, chartH = height - chartY - 30;
    const cell = chartW / 24, max = Math.max(1, ...buckets.map(b => b.mb));
    text(ctx, buckets.some(b => b.samples) ? metrics.perMember ? '套餐池区间用量 · 采样小时' : '今日区间用量 · 采样小时' : result.history.note,
      chartX, 87, chartW, 12, 8, UF.muted);
    buckets.forEach((bucket, hour) => {
      const center = chartX + (hour + 0.5) * cell;
      const barWidth = Math.max(1, cell - 3);
      ctx.setFillColor(new Color(hour % 6 === 0 ? UF.gridMajor : UF.gridMinor));
      ctx.fillRect(new Rect(center - 0.25, chartY, 0.5, chartH));
      if (bucket.mb > 0) {
        const h = Math.max(1, bucket.mb / max * chartH);
        ctx.setFillColor(new Color(UF.purple));
        ctx.fillRect(new Rect(center - barWidth / 2, chartY + chartH - h, barWidth, h));
      } else if (bucket.samples) {
        ctx.setFillColor(new Color(UF.purple));
        ctx.fillRect(new Rect(center - barWidth / 2, chartY + chartH - 1, barWidth, 1));
      }
    });
    [0, 6, 12, 18, 23].forEach(h => text(ctx, String(h).padStart(2, '0'), chartX + (h + 0.5) * cell - 9, chartY + chartH + 2, 18, 10, 7, UF.muted, true, true));
  } else {
    drawMetric(ctx, metrics.left, metrics.leftLabel, pad, 17, width - 2 * pad, true);
    drawMetric(ctx, metrics.right, metrics.rightLabel, pad, 85, width - 2 * pad, true);
  }
  const date = new Date(data.at);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const label = result.stale ? `缓存 ${dayKey(data.at).slice(5)} ${time} · 点击重试`
    : metrics.perMember ? metrics.note : data.warnings.length || metrics.omitted ? '另有明细 · 点击查看' : `已用 / 总量 · ${time}`;
  // 正常的小号组件省略页脚，给底部留出完整留白；异常缓存仍明确提示。
  if (medium || result.stale || data.warnings.length || metrics.omitted || metrics.perMember) {
    text(ctx, label, pad + 2, height - 18, width - 2 * pad - 4, 9, 6.5, result.stale || data.warnings.length || metrics.omitted ? UF.warning : UF.muted);
  }
  return ctx.getImage();
}

function widgetSize(medium) {
  const screen = Device.screenSize();
  const width = Math.min(screen.width, screen.height);
  const sizes = [[320, 141, 292], [360, 155, 329], [375, 155, 329], [390, 158, 338], [393, 158, 338],
    [402, 162, 344], [414, 169, 360], [428, 170, 364], [430, 170, 364], [440, 174, 372]];
  const closest = sizes.reduce((a, b) => Math.abs(b[0] - width) < Math.abs(a[0] - width) ? b : a);
  return { width: medium ? closest[2] : closest[1], height: closest[1] };
}

function makeWidget(result, medium) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color(UF.bg);
  widget.setPadding(0, 0, 0, 0);
  widget.url = 'scriptable:///run?scriptName=' + encodeURIComponent(Script.name());
  widget.refreshAfterDate = new Date(Date.now() + UF.refreshMinutes * 60000);
  const size = widgetSize(medium);
  // 整卡背景由系统适配尺寸，不再放置固定宽度图片，避免图片边缘露出细线。
  widget.backgroundImage = renderImage(result, medium, size.width, size.height);
  return widget;
}

function errorWidget(message) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color(UF.bg);
  widget.setPadding(15, 15, 15, 15);
  const title = widget.addText('联通流量'); title.textColor = new Color(UF.text); title.font = Font.boldSystemFont(16);
  widget.addSpacer(10);
  const msg = widget.addText(message); msg.textColor = new Color(UF.warning); msg.font = Font.systemFont(11);
  widget.url = 'scriptable:///run?scriptName=' + encodeURIComponent(Script.name());
  widget.refreshAfterDate = new Date(Date.now() + 15 * 60000);
  return widget;
}

async function alertMessage(title, message) {
  const a = new Alert(); a.title = title; a.message = message; a.addAction('好'); await a.presentAlert();
}

async function chooseCategory(store, result) {
  const list = result && result.history.data.packages;
  if (!list || !list.length) return alertMessage('暂无明细', '请先成功查询一次套餐');
  const a = new Alert(); a.title = '套餐分类';
  a.message = '共享套餐按整个流量池统计。点选套餐可选择共享通用、非共享通用、定向或排除。';
  const labels = { general: '通用', directed: '定向', ignore: '排除' };
  list.forEach(p => a.addAction(`[${p.category === 'general' && p.shared != null ? p.shared ? '共享通用' : '非共享通用' : labels[p.category]}] ${p.name}`)); a.addCancelAction('取消');
  const index = await a.presentSheet(); if (index < 0) return;
  const p = list[index], b = new Alert(); b.title = p.name;
  b.message = `已用 ${formatMB(p.used)} / 总量 ${p.unlimited ? '不限量' : formatMB(p.total)}`;
  ['共享通用', '非共享通用', '通用（自动识别）', '定向', '排除'].forEach(s => b.addAction(s)); b.addCancelAction('取消');
  const selected = await b.presentSheet(); if (selected < 0) return;
  const settings = store.read('categories', {}); settings[p.id] = ['shared', 'exclusive', 'general', 'directed', 'ignore'][selected];
  store.write('categories', settings);
  // 分类改变后旧图表口径不再一致，清除旧图表再查询。
  store.clear();
  await alertMessage('分类已保存', '再次运行脚本即可刷新数据，并重新积累历史。');
}

function validateUpdateSource(source) {
  if (typeof source !== 'string' || source.length < 8000 || source.length > 512000
    || !source.includes('// UnicomFlow Scriptable Widget') || !source.includes('function createWidgetClass(DmYY)')) {
    throw new Error('下载内容不是完整的联通流量脚本，未替换当前文件');
  }
  const match = source.match(/^const UF_VERSION = ['"](\d+\.\d+\.\d+)['"];$/m);
  if (!match) throw new Error('无法识别下载脚本的版本，未替换当前文件');
  try { new Function('return (async () => {\n' + source + '\n})'); }
  catch (_) { throw new Error('下载脚本语法检查未通过，未替换当前文件'); }
  return match[1];
}

function newerVersion(remote, current) {
  const a = remote.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function installUpdate(fm, path, source) {
  validateUpdateSource(source);
  if (!path || !fm.fileExists(path)) throw new Error('找不到当前脚本文件，已取消更新');
  try {
    fm.writeString(path, source);
    if (fm.readString(path) !== source) throw new Error('写入校验失败');
  } catch (_) {
    throw new Error('脚本写入未完成，请从仓库重新下载并替换脚本');
  }
}

// DmYY 负责分组配置页与尺寸预览，Cookie 仍逐项直读，不使用批量代理缓存。
function createWidgetClass(DmYY) {
  return class UnicomFlowWidget extends DmYY {
    constructor(arg) {
      super(arg);
      this.name = '联通流量';
      this.en = 'UnicomFlow';
      this.store = storage();
      this.result = null;
      this.failure = '';
      applyTheme(this.settings);
      if (!this.settings.refreshAfterDate) this.settings.refreshAfterDate = String(UF_DEFAULTS.refreshMinutes);
      if (config.runsInApp) this.registerMenus();
    }

    applySettings() {
      const domain = String(this.settings.flowBoxjsDomain || this.baseSettings.boxjsDomain || 'boxjs.net').trim();
      if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(domain)) throw new Error('BoxJS 域名格式不正确，请只填写域名，例如 boxjs.net');
      UF.boxjs = 'http://' + domain;
      const minutes = Number(this.settings.refreshAfterDate);
      UF.refreshMinutes = Number.isFinite(minutes) && minutes >= 5 && minutes <= 1440 ? minutes : UF_DEFAULTS.refreshMinutes;
      this.settings.refreshAfterDate = String(UF.refreshMinutes);
      applyTheme(this.settings);
      UF.displayMode = this.settings.displayMode === '主副卡分开显示' ? '主副卡分开显示' : '统一显示';
    }

    async loadResult() {
      this.result = null;
      this.failure = '';
      try { this.applySettings(); this.result = await refresh(this.store); }
      catch (error) {
        this.failure = error.message || '查询失败';
        const old = this.store.read('history', null);
        if (old && old.version === 1 && old.data) this.result = { history: old, stale: true, error: this.failure };
      }
      return this.result;
    }

    async render() {
      if (!['small', 'medium'].includes(this.widgetFamily)) return errorWidget('请添加小号或中号组件');
      await this.loadResult();
      return this.result ? makeWidget(this.result, this.widgetFamily === 'medium') : errorWidget(this.failure);
    }

    // Runing 根据这些方法生成“小尺寸 / 中尺寸”预览入口。
    async renderSmall() { this.widgetFamily = 'small'; return this.render(); }
    async renderMedium() { this.widgetFamily = 'medium'; return this.render(); }

    async renderAppView(options) {
      // 沿用 DmYY 卡片分组和菜单图标，不显示默认的第三方作者头像。
      return super.renderAppView(options, false);
    }

    async checkAndUpdateScript() {
      try {
        const request = new Request(UF_UPDATE_URL + '?t=' + Date.now());
        request.timeoutInterval = 15;
        const source = await request.loadString();
        const remote = validateUpdateSource(source);
        if (!newerVersion(remote, UF_VERSION)) return alertMessage('无需更新', `当前版本 ${UF_VERSION}，已是最新版本。`);
        const path = module.filename;
        const local = FileManager.local();
        const cloud = local.isFileStoredIniCloud(path);
        const fm = cloud ? FileManager.iCloud() : local;
        if (cloud) await fm.downloadFileFromiCloud(path);
        if (!fm.fileExists(path)) throw new Error('找不到当前脚本文件，已取消更新');
        const a = new Alert(); a.title = '发现脚本更新';
        a.message = `${UF_VERSION} → ${remote}\n确认后直接替换脚本，保留主题设置、历史数据和 QX Cookie。`;
        a.addAction('更新'); a.addCancelAction('取消');
        if (await a.presentAlert() < 0) return;
        installUpdate(fm, path, source);
        await alertMessage('更新成功', `已更新到 ${remote}，关闭配置页后重新运行即可。`);
      } catch (error) {
        await alertMessage('更新未完成', error.message || '下载失败，请稍后再试');
      }
    }

    async refreshFromQX() {
      await this.loadResult();
      await alertMessage('代理缓存', this.failure || '已直接读取 QX 的联通 Cookie 并刷新套餐。现在可预览组件；Cookie 不会保存到组件设置。');
    }

    async showMembers() {
      await this.loadResult();
      if (!this.result) return alertMessage('主副卡用量', this.failure);
      const members = this.result.history.data.members || [];
      if (!members.length) return alertMessage('主副卡用量', '未识别到成员用量，可能是接口未返回或字段尚未适配。请打开“成员字段检查”复制报告，不能从共享池总量推算逐卡用量。');
      const a = new Alert(); a.title = '主副卡用量';
      a.message = (this.result.stale ? '当前为缓存数据。\n' : '') + '按卡查看接口返回的流量包明细；角色未标明时显示“成员卡”。';
      members.forEach(member => a.addAction(`${member.role} ${member.phone}${member.current ? ' · 当前登录' : ''}`));
      a.addCancelAction('取消'); const index = await a.presentSheet(); if (index < 0) return;
      const member = members[index];
      const lines = member.records.map(record => `${record.name}\n已用：${record.conflict ? '返回数值不一致' : formatMB(record.used)}`);
      const known = member.records.filter(record => record.used != null && !record.conflict);
      const summary = known.length ? `已返回明细合计：${formatMB(known.reduce((sum, record) => sum + record.used, 0))}\n\n` : '';
      await alertMessage(`${member.role} ${member.phone}`, summary + (lines.join('\n\n') || '接口未返回这张卡的用量。')
        + '\n\n仅统计接口明确归属这张卡的用量，缺失项显示 --，不代表整张卡的全部用量。');
    }

    async memberDiagnostics() {
      await this.loadResult();
      const report = this.result && this.result.history.data.memberReport;
      if (!report) return alertMessage('成员字段检查', this.failure || '尚无结构报告，请先刷新数据');
      const a = new Alert(); a.title = '成员字段检查';
      a.message = (this.result.stale ? '当前为缓存报告。\n' : '') + report;
      a.addAction('复制报告'); a.addCancelAction('关闭');
      if (await a.presentAlert() === 0) Pasteboard.copyString(report);
    }

    async connectionStatus() {
      await this.loadResult();
      await alertMessage('连接检查', this.failure || `QX Cookie：已读取\n套餐接口：成功\n识别流量包：${this.result.history.data.packages.length}\n${this.result.history.data.warnings.join('\n')}\n\nCookie 未写入文件或日志。`);
    }

    async clearHistory() {
      const confirm = new Alert(); confirm.title = '清除历史？'; confirm.message = '只清除本组件的快照和用量图；QX Cookie 保留。';
      confirm.addDestructiveAction('清除'); confirm.addCancelAction('取消');
      if (await confirm.presentAlert() === 0) { this.store.clear(); this.result = null; }
    }

    async basicSettings() {
      return this.renderAppView([{ title: '基础设置', menu: [
        { name: 'flowBoxjsDomain', val: 'flowBoxjsDomain', title: 'BoxJS 域名', desc: '只填域名，不含 http://',
          type: 'input', defaultValue: this.baseSettings.boxjsDomain || 'boxjs.net', placeholder: 'boxjs.net', icon: { name: 'network', color: '#007AFF' } },
        { name: 'refreshAfterDate', val: 'refreshAfterDate', title: '刷新间隔', desc: '5—1440 分钟；实际刷新由 iOS 调度',
          type: 'input', placeholder: '30', icon: { name: 'clock', color: '#34C759' },
          onClick: async () => {
            const a = new Alert(); a.title = '刷新间隔'; a.message = '单位为分钟，范围 5—1440；实际刷新由 iOS 调度。';
            a.addTextField('30', String(this.settings.refreshAfterDate || '30')); a.addAction('保存'); a.addCancelAction('取消');
            if (await a.presentAlert() < 0) return;
            const n = Number(a.textFieldValue(0));
            if (!Number.isFinite(n) || n < 5 || n > 1440) return alertMessage('未保存', '请输入 5—1440 之间的分钟数');
            this.settings.refreshAfterDate = String(n); this.saveSettings(false);
          } },
      ] }]);
    }

    async colorSettings() {
      const light = this.settings.theme === '白色';
      const prefix = light ? 'white' : 'black';
      const palette = UF_THEMES[light ? '白色' : '黑色'];
      return this.renderAppView([{ title: `${light ? '白色' : '黑色'}主题颜色`, menu: [
        { title: '组件底色', val: prefix + 'CardColor', type: 'color', defaultValue: '#' + palette.bg, icon: { name: 'square.fill', color: '#555555' } },
        { title: '数字与标题', val: prefix + 'NumberColor', type: 'color', defaultValue: '#' + palette.text, icon: { name: 'textformat', color: '#007AFF' } },
        { title: '流量进度条', val: prefix + 'FlowBarColor', type: 'color', defaultValue: '#' + palette.blue, icon: { name: 'chart.bar.fill', color: '#0A94FF' } },
        { title: '历史用量图', val: prefix + 'ChartBarColor', type: 'color', defaultValue: '#' + palette.purple, icon: { name: 'chart.bar.xaxis', color: '#8A73FF' } },
      ] }]);
    }

    registerMenus() {
      const action = (name, title, symbol, color, onClick) => ({ name, title, type: 'input', icon: { name: symbol, color }, onClick });
      this.registerAction({ title: '组件配置', menu: [
        action('flowUpdate', '脚本更新', 'arrow.down.circle.fill', '#007AFF', () => this.checkAndUpdateScript()),
        { name: 'displayMode', val: 'displayMode', title: '显示方式', type: 'select', options: ['统一显示', '主副卡分开显示'], defaultValue: '统一显示', icon: { name: 'person.2.fill', color: '#5856D6' } },
        { name: 'theme', val: 'theme', title: '组件主题', type: 'select', options: ['黑色', '白色'], defaultValue: '黑色', icon: { name: 'circle.lefthalf.filled', color: '#555555' } },
        action('flowCategories', '套餐分类', 'list.bullet', '#007AFF', async () => {
          await this.loadResult();
          if (!this.result) return alertMessage('暂无明细', this.failure);
          await chooseCategory(this.store, this.result);
        }),
        action('flowColors', '颜色配置', 'paintpalette.fill', '#AF52DE', () => this.colorSettings()),
      ] });
      this.registerAction({ title: '账户与数据', menu: [
        action('flowAccount', '账户设置', 'person.crop.circle', '#FF9500', () => alertMessage('账户设置',
          '使用 QX 现有联通重写保存的 YaYa_10010.cookie，无需手动填写。\n\nCookie 失效时进入联通 App 首页 → 流量查询，再点“代理缓存”刷新。')),
        action('flowMembers', '主副卡用量', 'person.2.fill', '#5856D6', () => this.showMembers()),
        action('flowMemberDiagnostics', '成员字段检查', 'doc.text.magnifyingglass', '#8E8E93', () => this.memberDiagnostics()),
        action('flowProxy', '代理缓存', 'shippingbox.fill', '#34C759', () => this.refreshFromQX()),
        action('flowStatus', '连接检查', 'network', '#007AFF', () => this.connectionStatus()),
      ] });
      this.registerAction({ title: '基础设置', menu: [
        action('flowBasic', '基础设置', 'gearshape.fill', '#8E8E93', () => this.basicSettings()),
        action('flowClear', '清除历史', 'trash', '#FF3B30', () => this.clearHistory()),
        action('flowReload', '重载组件', 'arrow.clockwise', '#007AFF', () => this.reopenScript()),
      ] });
    }
  };
}

async function main() {
  let dependency;
  try { dependency = importModule('DmYY'); }
  catch (_) {
    const message = '请先将 DmYY.js 放入同一 Scriptable 脚本目录，再运行本脚本。';
    if (config.runsInWidget) Script.setWidget(errorWidget(message));
    else await alertMessage('缺少 DmYY 依赖', message);
    Script.complete(); return;
  }
  const Widget = createWidgetClass(dependency.DmYY);
  await dependency.Runing(Widget, args.widgetParameter || '', false);
}

// 便于在桌面验证纯数据逻辑；Scriptable 不定义该变量。
if (typeof UNICOM_FLOW_TEST === 'undefined') await main();
