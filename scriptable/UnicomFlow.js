// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: chart-bar;
/*
联通流量 · 小号 / 中号（使用 DmYY 配置菜单）
1. QX 开启现有 dompling 联通重写和 BoxJS。
2. 联通官方 App 首页 → 流量，收到 Cookie 写入成功通知。
3. 将 DmYY.js 放入同一 Scriptable 脚本目录，再新建脚本粘贴本文件。
4. 运行后在 DmYY 菜单中预览、配置和刷新数据，再添加桌面组件。
5. 小组件 Parameter 留空或 month 显示本月，填 today 显示今日已记录用量。
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
// 仅供仍检查版本号的旧客户端迁移；本脚本同步功能不再使用此标识。
const UF_VERSION = '1.0.8';
const UF_UPDATE_URL = 'https://raw.githubusercontent.com/42vio/quantumultx-scripts/main/scriptable/UnicomFlow.js';

const UF = {
  boxjs: 'http://boxjs.net',
  cookieKey: '@YaYa_10010.cookie',
  endpoint: 'https://mxx.client.10010.com/servicequerybusiness/operationservice/queryOcsPackageFlowLeftContentRevisedInJune',
  // 与成功 HAR 的实际表单一致；失败时仍可退回无表单请求。
  form: 'language=chinese',
  refreshMinutes: 30, dataRequestMinutes: 30, crossDayLimitMB: 10,
  folder: 'UnicomFlow',
  usageFont: 'SF Mono Medium', totalFont: '系统 Medium',
  usageFontSize: 25, totalFontSize: 11, titleFontSize: null,
  bg: '1C1C1E', text: 'F5F5F7', muted: 'A4A4AA', track: '454548',
  blue: '0A94FF', purple: '8A73FF', warning: 'FFD166', gridMajor: '38383C', gridMinor: '27272B',
};
const UF_DEFAULTS = { ...UF };

// 字体与字重合并选择；Menlo 没有原生 Medium，不以其他字体冒充。
const UF_NUMBER_FONTS = {
  '系统 Regular': 'system',
  '系统 Medium': 'system-medium',
  'SF Mono Regular': 'system-mono',
  'SF Mono Medium': 'system-mono-medium',
  'Menlo Regular': 'Menlo-Regular',
};

function normalizedNumberFont(value, fallback = 'SF Mono Regular') {
  if (Object.prototype.hasOwnProperty.call(UF_NUMBER_FONTS, value)) return value;
  return value === 'Menlo' ? 'Menlo Regular' : fallback;
}

function normalizedFontSize(value, kind) {
  const n = Number(value);
  const [min, max] = kind === 'usage' ? [12, 28] : [6, 14];
  return String(value == null ? '' : value).trim() && Number.isFinite(n) && n >= min && n <= max
    ? n : UF_DEFAULTS[kind + 'FontSize'];
}

function normalizedTitleSize(value) {
  const n = Number(value);
  return String(value == null ? '' : value).trim() && Number.isFinite(n) && n >= 8 && n <= 12 ? n : null;
}

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

function sharedComposition(packages, roster = []) {
  let main = 0, vice = 0, mainKnown = !!packages.length, viceKnown = !!packages.length;
  for (const pkg of packages) {
    const unique = new Map();
    for (const source of pkg.members || []) {
      const member = roster.find(item => item.id === source.id);
      const row = { ...source, role: member && member.roleConflict ? '成员卡' : member && member.role !== '成员卡' ? member.role : source.role };
      if (!unique.has(row.id)) unique.set(row.id, row);
      else if (unique.get(row.id).used !== row.used || unique.get(row.id).role !== row.role) unique.set(row.id, { ...row, used: null });
    }
    const rows = [...unique.values()];
    for (const [role, add] of [['主卡', value => { main += value; }], ['副卡', value => { vice += value; }]]) {
      const group = rows.filter(row => row.role === role);
      const valid = group.length > 0 && group.every(row => Number.isFinite(row.used) && row.used >= 0);
      if (role === '主卡') mainKnown = mainKnown && valid; else viceKnown = viceKnown && valid;
      if (valid) add(group.reduce((sum, row) => sum + row.used, 0));
    }
  }
  const used = packages.reduce((sum, pkg) => sum + pkg.used, 0);
  const complete = mainKnown && viceKnown && Math.abs(main + vice - used) <= Math.max(0.02, used * 1e-6);
  return { main: mainKnown ? main : null, vice: viceKnown ? vice : null, complete };
}

function displayMetrics(data) {
  const general = data.packages.filter(p => p.category === 'general');
  const shared = general.filter(p => p.shared === true);
  const exclusive = general.filter(p => p.shared === false);
  const composition = sharedComposition(shared, data.members || []);
  // 能识别两种套餐时分开显示；不根据 120GB/80GB 数值猜测套餐归属。
  if (shared.length && exclusive.length) {
    const omitted = data.packages.some(p => p.category !== 'ignore' && (p.category !== 'general' || p.shared == null));
    return { left: sumPackages(exclusive), right: { ...sumPackages(shared), composition }, leftLabel: '主卡独享', rightLabel: '共享流量', omitted, leftIds: exclusive.map(p => p.id), rightIds: shared.map(p => p.id) };
  }
  return { left: data.categories.general, right: data.categories.directed, leftLabel: '通用', rightLabel: '定向', omitted: false,
    leftIds: data.packages.filter(p => p.category === 'general').map(p => p.id),
    rightIds: data.packages.filter(p => p.category === 'directed').map(p => p.id) };
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

function formatMB(value, mode = 'usage') {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0MB';
  const scale = value >= 1024 ? [1024, 'GB'] : [1, 'MB'];
  const displayed = value / scale[0];
  const digits = value < 1024 && value >= 10 ? 0 : 1;
  const minimum = value < 1024 ? 0.1 : 0.01;
  let number = displayed > 0 && displayed < minimum ? '<' + minimum : displayed.toFixed(digits);
  if (value < 1024 && Number(number) >= 10) number = Number(number).toFixed(0);
  return `${mode === 'total' && !number.startsWith('<') ? String(Number(number)) : number}${scale[1]}`;
}

function widgetMode(parameter) {
  return String(parameter || '').trim().toLowerCase() === 'today' ? 'today' : 'month';
}

function formatGB(value, quota = false) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0';
  const gb = value / 1024;
  if (gb < 0.01) return '<0.01';
  const fixed = gb.toFixed(quota || gb < 1 ? 2 : 1);
  return quota ? String(Number(fixed)) : fixed;
}

// 复用现有同日区间，不保存第二份套餐增量或今日累计值。
function todayPackageUsage(history, ids, at) {
  if (!ids.length) return null;
  const events = (history.events || []).filter(event => Number.isFinite(event.from) && Number.isFinite(event.at)
    && event.from < event.at && event.at <= at && eventDate(event) === dayKey(at)
    && Number.isFinite(event.mb) && event.mb >= 0);
  if (!events.length) return null;
  const sum = usageSummary(events);
  const packages = history.data.packages.filter(p => p.category !== 'ignore');
  const selected = packages.filter(p => ids.includes(p.id));
  if (!selected.length || selected.length !== ids.length) return null;
  if (sum.mb === 0) return 0; // 总增量确认为零时，各套餐也都是零。
  // 单一分类可以直接复用整个区间总量，包含未知成员归属的部分。
  if (selected.length === packages.length) return sum.mb;
  // 累计用量为零的套餐，已有采样区间也必定为零。
  if (selected.every(p => p.used === 0)) return 0;
  if (packages.filter(p => !ids.includes(p.id)).every(p => p.used === 0)) return sum.mb;
  // 当前账户的共享池主卡累计值确认为零时，旧逐卡增量可准确对应共享／独享。
  // 主卡也用了共享池、有其他分类或当前成员不完整时不按比例猜测。
  if (!packages.every(p => p.category === 'general' && typeof p.shared === 'boolean')
    || !events.every(e => [e.mainMB,e.viceMB,e.unknownMB].every(n => Number.isFinite(n) && n >= 0)
      && Math.abs(e.mainMB + e.viceMB + e.unknownMB - e.mb) <= 1e-6)) return null;
  const shared = packages.filter(p => p.shared), exclusive = packages.filter(p => !p.shared);
  const composition = sharedComposition(shared, history.data.members || []);
  if (!shared.length || !exclusive.length || !composition.complete || composition.main !== 0) return null;
  if (sum.mainMB > exclusive.reduce((n,p) => n + p.used,0) + 0.02
    || sum.viceMB + sum.unknownMB > shared.reduce((n,p) => n + p.used,0) + 0.02) return null;
  // 独享包原来已明确计入主卡；仅这两类套餐时，未知成员归属的增量仍属于共享池。
  if (selected.length === shared.length && selected.every(p => p.shared)) return sum.viceMB + sum.unknownMB;
  if (selected.length === exclusive.length && selected.every(p => !p.shared)) return sum.mainMB;
  return null;
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
    // use 在语音中是分钟、短信中是条数；不能按缺省 MB 解析。
    if (!Array.isArray(value) && (/voice|sms/i.test(String(value.type || '')) || ['1', '2'].includes(String(value.elemType)))) return;
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
  if (['0', '1'].includes(String(raw.numberFlag))) signals.push(String(raw.numberFlag) === '1' ? '副卡' : '主卡');
  if (['0', '1'].includes(String(raw.viceCardflag))) signals.push(String(raw.viceCardflag) === '0' ? '副卡' : '主卡');
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

// 每个套餐分别核对逐卡累计值；未知部分不从共享池倒推。
function cardDelta(previous, sample) {
  let mainMB = 0, viceMB = 0, unknownMB = 0;
  for (const p of sample.packages.filter(p => p.category !== 'ignore')) {
    const before = previous.packages.find(item => item.id === p.id);
    const delta = p.used - before.used;
    if (p.category === 'general' && p.shared === false) { mainMB += delta; continue; }
    const a = sharedComposition([before], previous.members || []), b = sharedComposition([p], sample.members || []);
    const main = b.main - a.main, vice = b.vice - a.vice;
    if (a.complete && b.complete && main >= 0 && vice >= 0 && Math.abs(main + vice - delta) <= 0.05 && (main + vice > 0 || delta === 0)) {
      const factor = main + vice > 0 ? delta / (main + vice) : 0;
      mainMB += main * factor; viceMB += vice * factor;
    } else unknownMB += delta;
  }
  return { mainMB, viceMB, unknownMB };
}

function eventParts(event) {
  const parts = [event.mainMB, event.viceMB, event.unknownMB];
  return parts.every(value => Number.isFinite(value) && value >= 0) && Math.abs(parts.reduce((a, b) => a + b, 0) - event.mb) <= 1e-6
    ? { mainMB: parts[0], viceMB: parts[1], unknownMB: parts[2] } : { mainMB: 0, viceMB: 0, unknownMB: event.mb };
}

// 月度仅保存按日聚合；小时图仍使用短期区间记录，不累积秒级明细。
function smallCrossDayTime(event, limit = UF.crossDayLimitMB) {
  if (!Number.isFinite(event.from) || !Number.isFinite(event.at) || event.from >= event.at
    || !Number.isFinite(event.mb) || event.mb < 0 || limit <= 0 || event.mb > limit) return null;
  const midnight = new Date(event.from); midnight.setHours(24, 0, 0, 0);
  const end = midnight.getTime(), next = new Date(end); next.setDate(next.getDate() + 1);
  if (event.at < end || event.at >= next.getTime()) return null;
  return end - event.from > event.at - end ? end - 1 : event.at;
}

function eventDate(event) {
  return Number.isFinite(event.assignedAt) ? dayKey(event.assignedAt)
    : dayKey(event.from) === dayKey(event.at) ? dayKey(event.at) : null;
}

// 只迁移仍保存的跨日原始区间；移出待分配列表后再次运行不会重复累计。
function migrateSmallCrossDays(history, at = Date.now()) {
  if (!history || !history.months || UF.crossDayLimitMB <= 0) return history;
  let changed = false;
  const next = JSON.parse(JSON.stringify(history));
  for (const [monthKey, month] of Object.entries(next.months)) {
    const remaining = [];
    for (const event of month.crossDay || []) {
      const assignedAt = smallCrossDayTime(event);
      if (assignedAt == null || event.at > at || dayKey(event.from).slice(0, 7) !== monthKey
        || dayKey(event.at).slice(0, 7) !== monthKey) { remaining.push(event); continue; }
      const key = dayKey(assignedAt);
      month.days = month.days || {};
      const day = month.days[key] || (month.days[key] = { mb: 0, mainMB: 0, viceMB: 0, unknownMB: 0, intervals: 0, first: null, last: null, notes: [] });
      day.mb += event.mb; day.intervals++;
      for (const [part, value] of Object.entries(eventParts(event))) day[part] = (day[part] || 0) + value;
      day.first = day.first == null ? event.from : Math.min(day.first, event.from);
      day.last = day.last == null ? event.at : Math.max(day.last, event.at);
      day.notes = day.notes || [];
      day.notes.push(`跨日小流量近似归入（${new Date(event.from).toLocaleString('zh-CN', { hour12: false })} → ${new Date(event.at).toLocaleString('zh-CN', { hour12: false })}）`);
      if (event.at >= at - 7 * 86400000 && !(next.events || []).some(saved => saved.from === event.from && saved.at === event.at)) {
        (next.events || (next.events = [])).push({ ...event, assignedAt });
      }
      changed = true;
    }
    month.crossDay = remaining;
    for (const [date, day] of Object.entries(month.days || {})) {
      if (!remaining.some(event => dayKey(event.from) <= date && dayKey(event.at) >= date))
        day.notes = (day.notes || []).filter(note => note !== '跨日区间未分配');
    }
  }
  if (!changed) return history;
  next.events = (next.events || []).sort((a, b) => a.at - b.at);
  return next;
}

function updateMonths(previous, sample, prev, interval, note) {
  const months = JSON.parse(JSON.stringify(previous || {}));
  const now = new Date(sample.at);
  const oldest = dayKey(new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime()).slice(0, 7);
  const current = dayKey(sample.at).slice(0, 7);
  for (const key of Object.keys(months)) if (key < oldest || key > current) delete months[key];
  const day = time => {
    const key = dayKey(time), month = key.slice(0, 7);
    if (month < oldest || month > current) return null;
    if (!months[month]) months[month] = { days: {}, crossDay: [] };
    if (!months[month].days[key]) months[month].days[key] = { mb: 0, mainMB: 0, viceMB: 0, unknownMB: 0, intervals: 0, first: null, last: null, notes: [] };
    return months[month].days[key];
  };
  const touch = time => {
    const d = day(time); if (!d) return;
    d.first = d.first == null ? time : Math.min(d.first, time);
    d.last = d.last == null ? time : Math.max(d.last, time);
  };
  const record = event => {
    if (!Number.isFinite(event.from) || !Number.isFinite(event.at) || event.from >= event.at || event.at > sample.at
      || !Number.isFinite(event.mb) || event.mb < 0) return;
    touch(event.from); touch(event.at);
    if (eventDate(event)) {
      const d = day(event.assignedAt == null ? event.at : event.assignedAt); if (d) { d.mb += event.mb; d.intervals++;
        for (const [key, value] of Object.entries(eventParts(event))) d[key] += value;
        if (event.assignedAt != null) d.notes.push(`跨日小流量近似归入（${new Date(event.from).toLocaleString('zh-CN', { hour12: false })} → ${new Date(event.at).toLocaleString('zh-CN', { hour12: false })}）`);
      }
    } else {
      const month = months[dayKey(event.at).slice(0, 7)];
      if (month) month.crossDay.push({ from: event.from, at: event.at, mb: event.mb, ...eventParts(event) });
      const start = new Date(event.from); start.setHours(0, 0, 0, 0);
      // 跨日区间只能确认总量，不能分配到各日，也不平均插值。
      for (let i = 0; i < 63 && start.getTime() <= event.at; i++, start.setDate(start.getDate() + 1)) {
        const d = day(start.getTime());
        if (d && !d.notes.includes('跨日区间未分配')) d.notes.push('跨日区间未分配');
      }
    }
  };
  if (prev) touch(prev.at);
  touch(sample.at);
  if (interval) record(interval);
  else {
    const d = day(sample.at);
    const message = prev ? note : '首次记录，仅建立基线';
    if (!d.notes.includes(message)) d.notes.push(message);
  }
  return months;
}

function usageSummary(records) {
  if (!records.length) return { mb: null, mainMB: null, viceMB: null, unknownMB: null };
  return records.reduce((sum, record) => {
    sum.mb += record.mb;
    for (const [key, value] of Object.entries(eventParts(record))) sum[key] += value;
    return sum;
  }, { mb: 0, mainMB: 0, viceMB: 0, unknownMB: 0 });
}

function monthlyReport(history, at = Date.now(), selectedMonth = dayKey(at).slice(0, 7)) {
  const today = dayKey(at), currentMonth = today.slice(0, 7);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth) && selectedMonth <= currentMonth ? selectedMonth : currentMonth;
  const date = new Date(Number(month.slice(0,4)), Number(month.slice(5))-1, 1);
  const savedMonths = history.months || {};
  const saved = savedMonths[month] || { days: {}, crossDay: [] };
  const count = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const days = Array.from({ length: count }, (_, index) => {
    const key = `${month}-${String(index + 1).padStart(2, '0')}`, d = saved.days[key];
    return { key, day: index + 1, future: key > today, mb: d && d.intervals ? d.mb : null,
      mainMB: d && d.intervals ? d.mainMB : null, viceMB: d && d.intervals ? d.viceMB : null, unknownMB: d && d.intervals ? d.unknownMB : null,
      intervals: d ? d.intervals : 0, first: d ? d.first : null, last: d ? d.last : null, notes: d ? d.notes : [] };
  });
  const crossDay = (saved.crossDay || []).filter(e => Number.isFinite(e.mb) && e.mb >= 0
    && dayKey(e.from).slice(0, 7) === month && dayKey(e.at).slice(0, 7) === month);
  const summary = usageSummary([...days.filter(d => d.mb != null), ...crossDay]);
  return { month, today, days, totalMB: summary.mb, summary,
    dayTotalMB: days.some(d => d.mb != null) ? days.reduce((sum, d) => sum + (d.mb || 0), 0) : null,
    crossDay, unallocatedMB: crossDay.reduce((sum, e) => sum + e.mb, 0), lastSuccess: history.data.at };
}

function yearlyReport(history, at = Date.now()) {
  const now = new Date(at), current = dayKey(at).slice(0, 7);
  const days = Array.from({ length: 12 }, (_, index) => {
    const key = dayKey(new Date(now.getFullYear(), now.getMonth() - 11 + index, 1).getTime()).slice(0, 7);
    const saved = history.months && history.months[key];
    const daily = Object.values(saved && saved.days || {});
    // 同月跨日区间无法拆到某一天，但可以准确归入该月，只计一次。
    const cross = (saved && saved.crossDay || []).filter(e => dayKey(e.from).slice(0, 7) === key && dayKey(e.at).slice(0, 7) === key);
    const records = [...daily.filter(d => d.intervals > 0), ...cross];
    const parts = usageSummary(records);
    const first = daily.map(d => d.first).filter(Number.isFinite), last = daily.map(d => d.last).filter(Number.isFinite);
    const notes = [...new Set(daily.flatMap(d => d.notes).filter(note => note !== '跨日区间未分配'))];
    const end = dayKey(new Date(now.getFullYear(), now.getMonth() - 10 + index, 0).getTime());
    const partial = records.length > 0 && (!first.length || !last.length || notes.length > 0
      || dayKey(Math.min(...first)) !== key + '-01' || dayKey(Math.max(...last)) !== end);
    return { key, day: key.slice(5) + '月', future: false, partial,
      mb: records.length ? parts.mb : null, mainMB: records.length ? parts.mainMB : null,
      viceMB: records.length ? parts.viceMB : null, unknownMB: records.length ? parts.unknownMB : null,
      intervals: daily.reduce((sum, d) => sum + d.intervals, 0) + cross.length,
      first: first.length ? Math.min(...first) : null, last: last.length ? Math.max(...last) : null,
      notes };
  });
  // 月均仅对已结束且有记录的月份计算；当前月与无数据月份不补零。
  const ended = days.filter(d => d.key < current && d.mb != null);
  const average = usageSummary(ended);
  if (ended.length) for (const key of ['mb', 'mainMB', 'viceMB', 'unknownMB']) average[key] /= ended.length;
  average.monthCount = ended.length;
  average.partialMonthCount = ended.filter(d => d.partial).length;
  return { period: 'months', month: current, today: current, days, average,
    crossDay: [], unallocatedMB: 0, lastSuccess: history.data.at };
}

function hourlyReport(history, at = Date.now(), selectedDay = dayKey(at)) {
  const actualToday = dayKey(at), parsed = new Date(selectedDay + 'T00:00:00');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(selectedDay) && Number.isFinite(parsed.getTime()) && dayKey(parsed) === selectedDay && selectedDay <= actualToday ? selectedDay : actualToday;
  const hour = date === actualToday ? new Date(at).getHours() : 23;
  const days = Array.from({ length: 24 }, (_, index) => {
    const events = (history.events || []).filter(e => eventDate(e) === date && new Date(e.assignedAt == null ? e.at : e.assignedAt).getHours() === index && e.at <= at);
    const parts = events.reduce((sum, e) => { sum.mb += e.mb; for (const [key, value] of Object.entries(eventParts(e))) sum[key] += value; return sum; }, { mb: 0, mainMB: 0, viceMB: 0, unknownMB: 0 });
    const known = events.length > 0 && index <= hour;
    return { key: `${date} ${String(index).padStart(2, '0')}:00`, day: String(index).padStart(2, '0'), future: index > hour,
      mb: known ? parts.mb : null, mainMB: known ? parts.mainMB : null, viceMB: known ? parts.viceMB : null, unknownMB: known ? parts.unknownMB : null,
      intervals: known ? events.length : 0, first: known ? Math.min(...events.map(e => e.from)) : null,
      last: known ? Math.max(...events.map(e => e.at)) : null,
      notes: [...(events.some(e => new Date(e.from).getHours() !== index) ? ['跨小时区间计入结束小时，未平均摊分'] : []), ...(events.some(e => e.assignedAt != null) ? ['跨日小流量近似归入'] : [])] };
  });
  const saved = history.months && history.months[date.slice(0, 7)];
  const crossDay = (saved && saved.crossDay || []).filter(e => dayKey(e.from) <= date && dayKey(e.at) >= date);
  return { period: 'hours', month: date, today: `${date} ${String(hour).padStart(2, '0')}:00`, days,
    totalMB: days.some(d => d.mb != null) ? days.reduce((sum, d) => sum + (d.mb || 0), 0) : null,
    crossDay, unallocatedMB: crossDay.reduce((sum, e) => sum + e.mb, 0), lastSuccess: history.data.at };
}

// 区间两端是实际成功采样时间；复用旧记录，不按小时或每日用量记录推算请求。
function successfulQueryTimes(history, at) {
  const events = [...(history.events || []), ...Object.values(history.months || {}).flatMap(month => month.crossDay || [])];
  const endpoints = events.filter(event => Number.isFinite(event.from) && Number.isFinite(event.at)
    && event.from < event.at && event.at <= at).flatMap(event => [event.from, event.at]);
  return [...new Set([...(history.queryTimes || []), ...endpoints,
    history.last && history.last.at, history.data && history.data.at])]
    .filter(time => Number.isFinite(time) && time <= at && time >= at - 7 * 86400000
      && (!Number.isFinite(history.queryLogClearedAt) || time > history.queryLogClearedAt)).sort((a, b) => a - b);
}

function refreshRecords(history, at = Date.now(), executions = []) {
  const times = successfulQueryTimes(history, at);
  const rows = times.map((time, index) => ({ at: time, interval: index ? time - times[index - 1] : null }))
    .filter(row => row.at >= at - 86400000);
  const intervals = rows.map(row => row.interval).filter(value => value != null);
  const recent = executions.filter(entry => Number.isFinite(entry.at) && entry.at <= at && entry.at >= at - 86400000);
  const entries = rows.map(row => ({ ...row, state: 'query', source: 'unknown',
    ...recent.find(entry => entry.state === 'query' && entry.at === row.at) }))
    .concat(recent.filter(entry => entry.state !== 'query')).sort((a, b) => b.at - a.at);
  return { rows: rows.reverse(), entries, count: rows.length,
    cached: recent.filter(entry => entry.state === 'cache').length, failed: recent.filter(entry => entry.state === 'failed').length,
    average: intervals.length ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : null,
    longest: intervals.length ? Math.max(...intervals) : null };
}

function statisticsReports(history, at = Date.now(), executions = []) {
  // 只在打开页面时生成可选日期／月份的数据，不写入历史或复制保存每日累计。
  const hours = hourlyReport(history, at), month = monthlyReport(history, at), year = yearlyReport(history, at);
  const earliest = new Date(at); earliest.setHours(0,0,0,0); earliest.setDate(earliest.getDate()-6);
  const dates = {};
  const available = [...new Set((history.events || []).filter(e => Number.isFinite(e.from) && Number.isFinite(e.at)
    && e.from < e.at && e.at <= at && eventDate(e) && e.at >= earliest.getTime()).map(e => eventDate(e)))].sort();
  if (available.length) for (const cursor = new Date(available[0] + 'T00:00:00'); dayKey(cursor) < hours.month; cursor.setDate(cursor.getDate()+1)) {
    const key = dayKey(cursor); dates[key] = hourlyReport(history, at, key);
  }
  const months = {};
  for (const key of Object.keys(history.months || {}).sort()) {
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(key) && key >= year.days[0].key && key < month.month) months[key] = monthlyReport(history, at, key);
  }
  return { hours, month, year, dates, months, refresh: refreshRecords(history, at, executions) };
}

function previewHTML(images, sizes, mode = 'month', stale = false) {
  const payload = JSON.stringify(images).replace(/</g, '\\u003c');
  const light = parseInt(UF.bg.slice(0, 2), 16) > 150;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no"><style>
  *{box-sizing:border-box;touch-action:manipulation}[hidden]{display:none!important}body{margin:0;background:${light ? '#F3F5F9' : '#151517'};color:#${UF.text};font:14px -apple-system,sans-serif;-webkit-text-size-adjust:100%}.shell{max-width:520px;padding:52px 18px 24px;margin:auto}h1{font-size:26px;margin:0 0 8px}p{color:#${UF.muted};font-size:12px;line-height:1.7;margin:0 0 18px}.tabs{display:flex;padding:4px;gap:4px;border-radius:14px;background:${light ? '#E7EAF0' : '#2D2D31'};margin-bottom:24px}button{flex:1;min-height:44px;border:0;border-radius:10px;background:none;color:#${UF.muted};font:500 14px -apple-system,sans-serif}button.active{background:#${UF.bg};color:#${UF.text}}button:focus-visible{outline:2px solid #${UF.blue};outline-offset:2px}figure{margin:0 0 24px}figcaption{margin-bottom:10px;font-size:12px;color:#${UF.muted}}img{display:block;max-width:100%;height:auto}.small{width:${sizes.small.width}px;border-radius:22%}.medium{width:${sizes.medium.width}px;border-radius:${sizes.medium.height * .22}px}
  </style></head><body><main class="shell"><h1>组件预览</h1><p>${stale ? '当前为上次成功查询的缓存数据。' : '小号与中号使用同一份数据。'}切换模式不会额外查询，也不会修改桌面组件参数。</p><nav class="tabs" aria-label="用量模式"><button id="preview-month" type="button">当月</button><button id="preview-today" type="button">今日</button></nav><figure><figcaption>小号</figcaption><img id="preview-small" class="small" alt="小号组件预览" width="${sizes.small.width}" height="${sizes.small.height}"></figure><figure><figcaption>中号</figcaption><img id="preview-medium" class="medium" alt="中号组件预览" width="${sizes.medium.width}" height="${sizes.medium.height}"></figure></main><script>(()=>{
    const images=${payload};
    function show(mode){for(const key of ['month','today']){const button=document.getElementById('preview-'+key);button.classList.toggle('active',key===mode);button.setAttribute('aria-pressed',String(key===mode));}for(const size of ['small','medium'])document.getElementById('preview-'+size).src=images[mode][size];}
    for(const key of ['month','today'])document.getElementById('preview-'+key).onclick=()=>show(key);
    document.addEventListener('dblclick',event=>event.preventDefault(),{passive:false});show(${JSON.stringify(mode === 'today' ? 'today' : 'month')});
  })();</script></body></html>`;
}

function statisticsHTML(reports, stale = false, initialPeriod = 'hours', showRefresh = false) {
  const payload = JSON.stringify(reports).replace(/</g, '\\u003c');
  const light = parseInt(UF.bg.slice(0, 2), 16) * 0.299 + parseInt(UF.bg.slice(2, 4), 16) * 0.587 + parseInt(UF.bg.slice(4, 6), 16) * 0.114 > 150;
  const surface = light ? 'FFFFFF' : '242426', page = light ? 'F3F5F9' : '151517';
  const border = light ? 'E7EAF0' : '343438', soft = light ? 'F6F8FC' : '2D2D31';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><style>
  :root{color-scheme:${light ? 'light' : 'dark'};--text:#${UF.text};--muted:#${UF.muted};--blue:#${UF.blue};--purple:#${UF.purple};--warning:#${UF.warning};--line:#${border};--surface:#${surface};--soft:#${soft}}
  *{box-sizing:border-box;touch-action:manipulation}body{margin:0;background:#${page};color:var(--text);font:14px -apple-system,BlinkMacSystemFont,sans-serif;-webkit-text-size-adjust:100%}button{font:inherit;color:inherit;-webkit-tap-highlight-color:transparent}button:focus-visible{outline:2px solid var(--blue);outline-offset:2px}[hidden]{display:none!important}
  .shell{max-width:760px;margin:auto;padding:52px 18px 24px}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}h1{font-size:24px;letter-spacing:-.6px;margin:0 0 4px;font-weight:650}.eyebrow{font-size:12px;color:var(--muted)}.badge{font-size:11px;white-space:nowrap;padding:7px 10px;border-radius:20px;background:var(--soft);color:var(--muted)}.cached{color:var(--warning)}
  .tabs{display:grid;grid-template-columns:repeat(3,1fr);padding:4px;background:var(--soft);border-radius:14px;gap:4px;margin-bottom:8px}.tab{border:0;background:transparent;padding:8px 4px;border-radius:10px;color:var(--muted);font-size:13px;font-weight:500}.tab.active{background:var(--surface);color:var(--text);box-shadow:0 2px 8px #0000000c}
  .period-picker{display:grid;grid-template-columns:36px minmax(0,1fr) 36px;align-items:center;gap:6px;margin-bottom:10px}.period-picker button{height:36px;border:0;border-radius:12px;background:var(--soft);font-size:22px}.period-picker button:disabled{opacity:.3}.period-picker select{width:100%;min-width:0;height:36px;border:1px solid var(--line);border-radius:12px;padding:0 12px;color:var(--text);background:var(--surface);font:500 14px -apple-system,BlinkMacSystemFont,sans-serif;text-align:center}.period-picker select:disabled{opacity:1}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:18px;margin-bottom:14px;min-width:0}.hero{padding:15px 16px}.period-label{font-size:13px;color:var(--muted)}.total{margin:6px 0 8px;font-variant-numeric:tabular-nums;letter-spacing:-1px;font-size:36px;font-weight:500;line-height:1.1}.total small{font-size:17px;letter-spacing:0;color:var(--muted);font-weight:400;margin-left:7px}.coverage{font-size:12px;color:var(--muted);line-height:1.6}.totals{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px}.mini{padding:12px 13px;border-radius:13px;background:var(--soft)}.mini-label{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:6px}.mini strong{display:block;font-size:19px;font-weight:500;font-variant-numeric:tabular-nums;margin-top:6px}.main{color:var(--blue)}.vice{color:var(--purple)}.unconfirmed{font-size:12px;margin-top:12px;color:var(--warning)}
  h2{font-size:15px;font-weight:600;margin:0}.card-head{display:flex;justify-content:space-between;align-items:center;gap:8px}.hint{font-size:11px;color:var(--muted)}.chart-meta{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 12px;margin:12px 0 8px}.chart-max{font-size:11px;white-space:nowrap;color:var(--muted)}.chart-max strong{font-weight:500;color:var(--text);margin-left:5px;font-variant-numeric:tabular-nums}.legend{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:14px;font-size:11px;color:var(--muted);margin-left:auto}.legend span{display:inline-flex;align-items:center;gap:5px}.dot{display:inline-block;width:6px;height:6px;border-radius:50%;flex-shrink:0}.blue{background:var(--blue)}.purple{background:var(--purple)}.amber{background:var(--warning)}.gray{background:#${UF.track}}
  .scroll{overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch}.chart{display:flex;align-items:stretch;gap:5px;height:180px;padding:8px 3px 3px;background:repeating-linear-gradient(to bottom,var(--line) 0,var(--line) 1px,transparent 1px,transparent 56px);background-size:100% 113px;background-position:0 38px;background-repeat:no-repeat}.bar{flex:1;min-width:14px;padding:0 1px;border:0;background:transparent;border-radius:6px;display:flex;align-items:center;justify-content:flex-end;flex-direction:column;gap:9px}.fill{display:flex;flex-direction:column-reverse;overflow:hidden;width:100%;border-radius:4px 4px 1px 1px;background:var(--purple)}.fill.missing{background:#${UF.track}}.fill.future{background:transparent}.segment{display:block;width:100%;flex-shrink:0}.tick{height:18px;min-width:18px;padding:2px 4px;line-height:14px;border-radius:6px;font-size:10px;color:var(--muted);white-space:nowrap}.bar.selected .tick{background:var(--blue);color:#fff;font-weight:600}.chart-foot{margin-top:10px;line-height:1.6;font-size:11px;color:var(--muted)}
  .selected-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.selected-value{font-size:21px;font-weight:500;letter-spacing:-.4px}.selected-cards{display:flex;flex-wrap:wrap;gap:14px;margin:13px 0;font-size:13px}.detail{border-top:1px solid var(--line);padding-top:12px;color:var(--muted);font-size:12px;line-height:1.8;white-space:pre-line;overflow-wrap:anywhere}.status-note{margin:10px 0 0;font-size:11px;line-height:1.7;color:var(--muted)}
  .table-card{padding:18px 0 0;overflow:hidden}.table-card .card-head{padding:0 18px 14px}table{width:100%;min-width:545px;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:right;border-top:1px solid var(--line);padding:13px 12px;white-space:nowrap;font-size:12px}th{font-size:11px;font-weight:400;color:var(--muted);background:var(--soft)}th:first-child,td:first-child{text-align:left;position:sticky;left:0;z-index:1;background:var(--surface);padding-left:18px}th:first-child{background:var(--soft)}td:last-child{color:var(--muted);font-size:11px}tr.selected td{background:#${soft}}.date{border:0;padding:3px 0;background:none;color:var(--text);font-size:12px}tr.selected .date{color:var(--blue)}
  details{color:var(--muted);font-size:12px;line-height:1.8}summary{cursor:pointer;color:var(--text);font-size:13px;font-weight:500}details p{margin:10px 0 0}.cross-event{padding:10px 0;border-top:1px solid var(--line);font-size:12px;line-height:1.7;white-space:pre-line}footer{white-space:pre-line;color:var(--muted);font-size:11px;line-height:1.8;text-align:center;margin-top:20px}.range-note{margin:12px 0 0;color:var(--muted);font-size:11px;line-height:1.7}
  .records-details>summary{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 18px 18px;list-style:none;font-size:15px;font-weight:600}.records-details>summary::-webkit-details-marker{display:none}.records-details>summary .hint{margin-left:auto;font-weight:400}.records-details>summary::after{content:"›";font-size:22px;color:var(--muted);transform:rotate(90deg)}.records-details[open]>summary::after{transform:rotate(-90deg)}
  .hero .totals{margin-top:10px;gap:8px}.hero .mini{padding:8px 10px}.hero .mini strong{font-size:18px;margin-top:3px}.hero .coverage{line-height:1.4}.hero .range-note{margin-top:6px}.badge:not(.cached){display:none}
  .header-actions{display:flex;flex-direction:column;align-items:flex-end;gap:4px}.records-link{border:0;border-radius:12px;background:var(--soft);color:var(--blue);min-height:44px;padding:0 12px;white-space:nowrap;font-size:13px;font-weight:500}header{gap:12px}.refresh-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:14px}.refresh-summary .mini{padding:11px 8px;min-width:0}.refresh-summary strong{font-size:clamp(12px,3.6vw,17px);white-space:nowrap;line-height:1.3;margin-top:7px}.refresh-scope{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}.refresh-scope summary{font-size:11px;color:var(--muted);min-height:28px}.refresh-table{min-width:480px}.refresh-table th,.refresh-table td{padding:13px 14px}.refresh-table time{font-size:13px}.refresh-table td:first-child{padding-left:18px}.refresh-note{font-size:12px;line-height:1.8;color:var(--muted);margin:12px 0 0}.empty-records{text-align:center;padding:28px 18px;color:var(--muted);font-size:13px}
  </style></head><body><main class="shell">
  <header><div><h1 id="page-title">用量统计</h1><div class="eyebrow" id="page-subtitle">采样记录 · 非运营商账单</div></div><div class="header-actions"><button id="refresh-records-toggle" class="records-link" type="button" aria-expanded="false" aria-controls="refresh-records">刷新记录</button><span class="badge${stale ? ' cached' : ''}">${stale ? '缓存数据' : '本地记录'}</span></div></header>
  <section id="refresh-records" hidden aria-label="刷新记录">
    <section class="card"><div class="card-head"><h2>最近24小时</h2></div><div class="refresh-summary"><div class="mini"><div class="mini-label">查询成功</div><strong id="refresh-count"></strong></div><div class="mini"><div class="mini-label">平均间隔</div><strong id="refresh-average"></strong></div><div class="mini"><div class="mini-label">最长间隔</div><strong id="refresh-longest"></strong></div></div><details class="refresh-scope"><summary>统计说明</summary><p>间隔按相邻两次成功查询计算，包含手动刷新；平均与最长间隔可连接到24小时外的上一条成功记录。使用缓存与执行失败不计入成功次数和查询间隔。</p></details></section>
    <section class="card table-card"><div class="card-head"><h2>执行记录</h2><button id="clear-refresh-records" class="records-link" type="button" style="color:#FF3B30">清除记录</button></div><div class="scroll"><table class="refresh-table"><thead><tr><th>触发时间</th><th>来源</th><th>执行结果</th><th>查询间隔</th></tr></thead><tbody id="refresh-rows"></tbody></table></div><div id="refresh-empty" class="empty-records" hidden>最近24小时暂无执行记录</div></section>
    <p class="refresh-note" id="refresh-execution-summary"></p><p class="refresh-note">来源及执行结果从新版开始记录，旧成功记录标为来源未知。命中缓存表示脚本执行但未请求联通，不代表iOS是否重绘。日志最多保留7天、2000条，不保存Cookie或接口原文；切换页面不会发起请求。</p>
  </section>
  <div id="usage-content">
  <nav class="tabs" aria-label="统计周期"><button class="tab" id="tab-hours" type="button">单日</button><button class="tab" id="tab-month" type="button">单月</button><button class="tab" id="tab-year" type="button">月度趋势</button></nav>
  <div class="period-picker" id="period-picker"><button id="period-prev" type="button" aria-label="前一个周期">‹</button><select id="period-select" aria-label="选择日期"></select><button id="period-next" type="button" aria-label="后一个周期">›</button></div>
  <section class="card hero"><div class="period-label" id="period-label"></div><div class="total" id="total"></div><div class="coverage" id="coverage"></div><div id="cross-hint" class="range-note" hidden></div><div class="totals"><div class="mini"><div class="mini-label"><i class="dot blue"></i><span id="main-label">主卡</span></div><strong id="main-total" class="main"></strong></div><div class="mini"><div class="mini-label"><i class="dot purple"></i><span id="vice-label">副卡</span></div><strong id="vice-total" class="vice"></strong></div></div><div id="unknown-total" class="unconfirmed" hidden></div></section>
  <section class="card"><div class="card-head"><h2 id="chart-title"></h2><span id="chart-count" class="hint"></span></div><div class="chart-meta"><div class="chart-max">MAX<strong id="chart-max-value">—</strong></div><div class="legend"><span><i class="dot blue"></i>主卡</span><span><i class="dot purple"></i>副卡</span><span id="unknown-legend"><i class="dot amber"></i>未确认</span></div></div><div class="scroll"><div id="chart" class="chart"></div></div><div id="chart-foot" class="chart-foot"></div></section>
  <section class="card"><div class="selected-heading"><h2 id="selected"></h2><span id="selected-total" class="selected-value"></span></div><div class="selected-cards"><span id="selected-main" class="main"></span><span id="selected-vice" class="vice"></span><span id="selected-unknown" class="unconfirmed"></span></div><div id="detail" class="detail"></div><p id="selected-note" class="status-note"></p></section>
  <section class="card table-card"><details id="usage-records" class="records-details"><summary>明细记录<span class="hint">展开后可左右滑动</span></summary><div class="scroll"><table><thead><tr><th id="date-heading"></th><th>主卡</th><th>副卡</th><th>未确认</th><th>合计</th><th>记录情况</th></tr></thead><tbody id="rows"></tbody></table></div></details></section>
  <section class="card" id="cross-card"><details><summary id="cross-summary"></summary><p id="cross-description"></p><div id="cross-events"></div></details></section>
  <section class="card"><details><summary>统计口径与数据缺口</summary><p id="scope"></p><p>只统计成功查询间可确认的增量。无数据不等于零；短柱只是占位，用量以数值为准。套餐变更、累计计数回退或跨月时重新建立基线，不推算缺失用量。主卡包括共享部分与独享包；归属无法确认的部分单独列出。</p></details></section>
  <footer id="updated"></footer></div></main><script>
  (()=>{
    const reports=${payload}, initial=${JSON.stringify(initialPeriod)};
    const el=id=>document.getElementById(id), modes={hours:{label:'时段',title:'单日小时分布',width:500},month:{label:'日期',title:'单月每日分布',width:600},year:{label:'月份',title:'近12个月用量',width:0}};
    const amount=value=>{if(value==null)return '—';const displayed=value>=1024?value/1024:value;return value===0?'0 MB':(displayed<0.01?'<0.01':displayed.toFixed(2))+(value>=1024?' GB':' MB');};
    const totalFor=(report,key)=>report.period==='months'?report.average[key]:report.summary?report.summary[key]:report.days.some(d=>d.mb!=null)?report.days.reduce((sum,d)=>sum+(d[key]||0),0):null;
    const clock=(time,full)=>time==null?'无':full?new Date(time).toLocaleString('zh-CN',{hour12:false}):new Date(time).toLocaleTimeString('zh-CN',{hour12:false});
    const status=d=>current==='year'&&d.mb!=null?(d.key===report.month?'本月进行中':d.partial?'部分记录':'已结束'):d.future?'未到时间':d.mb==null?(d.first!=null?'仅基线':d.notes.length?'有缺口':'无采样'):d.notes.length?'有缺口':'采样区间';
    const selections={hours:reports.hours&&reports.hours.month,month:reports.month&&reports.month.month};
    let current='hours', report=reports.hours||reports.month;
    function periodChoices(key){return key==='hours'?[...Object.keys(reports.dates||{}),reports.hours.month].sort():[...Object.keys(reports.months||{}),reports.month.month].sort();}
    function selectedReport(key){return key==='year'?reports.year:key==='hours'?(reports.dates||{})[selections.hours]||reports.hours:(reports.months||{})[selections.month]||reports.month;}
    function changePeriod(offset){
      if(current==='year')return;
      const choices=periodChoices(current), index=choices.indexOf(selections[current]), next=index+offset;
      if(next<0||next>=choices.length)return;selections[current]=choices[next];render(current);
    }
    function renderPicker(key){
      el('period-picker').hidden=key==='year';if(key==='year')return;
      const choices=periodChoices(key), select=el('period-select');select.replaceChildren();
      for(const value of choices){const option=document.createElement('option');option.value=value;option.textContent=value+(key==='hours'&&value===reports.hours.month?' · 今天':key==='month'&&value===reports.month.month?' · 本月':'');select.append(option);}
      select.value=selections[key];select.disabled=choices.length===1;select.setAttribute('aria-label',key==='hours'?'选择日期':'选择月份');
      const index=choices.indexOf(selections[key]);el('period-prev').disabled=index<=0;el('period-next').disabled=index>=choices.length-1;
      el('period-prev').setAttribute('aria-label',key==='hours'?'前一天':'前一个月');el('period-next').setAttribute('aria-label',key==='hours'?'后一天':'后一个月');
    }
    function select(d){
      el('selected').textContent=d.key;el('selected-total').textContent=amount(d.mb);
      el('selected-main').textContent='主卡 '+amount(d.mainMB);el('selected-vice').textContent='副卡 '+amount(d.viceMB);
      el('selected-unknown').hidden=!(d.unknownMB>0);el('selected-unknown').textContent='未确认 '+amount(d.unknownMB);
      el('detail').textContent=d.first==null?'暂无成功采样记录':'有效区间 '+d.intervals+' 段\\n采样起止 '+clock(d.first,current==='year')+' — '+clock(d.last,current==='year');
      el('selected-note').textContent=(current==='year'&&d.key===report.month?'本月尚未结束，不参与月均。':current==='year'&&d.partial?'部分记录，不代表完整月用量。':'')+(d.future?'该时段尚未到达':d.notes.join('；')||(d.mb==null?'没有记录，未补零':'仅代表已记录区间，不保证覆盖完整时段'));
      Array.from(el('chart').children).forEach(item=>{const active=item.dataset.key===d.key;item.classList.toggle('selected',active);item.setAttribute('aria-pressed',String(active));});
      Array.from(el('rows').children).forEach(item=>item.classList.toggle('selected',item.dataset.key===d.key));
    }
    function render(key){
      current=key;report=selectedReport(key);const mode=modes[key];renderPicker(key);
      Object.keys(modes).forEach(name=>{el('tab-'+name).classList.toggle('active',name===key);el('tab-'+name).setAttribute('aria-pressed',String(name===key));});
      el('period-label').textContent=key==='year'?'已记录月均用量':report.month+(key==='hours'?' · 单日已记录用量':' · 单月已记录用量（含同月跨日）');
      el('total').textContent=key==='year'?(report.average.monthCount?amount(report.average.mb):'积累中'):amount(report.totalMB);
      el('main-label').textContent=key==='year'?'主卡月均':'主卡';el('vice-label').textContent=key==='year'?'副卡月均':'副卡';el('main-total').textContent=amount(totalFor(report,'mainMB'));el('vice-total').textContent=amount(totalFor(report,'viceMB'));
      const unknown=totalFor(report,'unknownMB');el('unknown-total').hidden=!(unknown>0);el('unknown-total').textContent=(key==='year'?'未确认月均 ':'归属未确认 ')+amount(unknown);el('unknown-legend').hidden=!report.days.some(d=>d.unknownMB>0);
      const recorded=report.days.filter(d=>d.mb!=null).length;
      el('coverage').textContent=key==='year'?(report.average.monthCount?'按 '+report.average.monthCount+' 个已结束月份计算 · 不含本月与无数据月'+(report.average.partialMonthCount?'（含 '+report.average.partialMonthCount+' 个部分记录月）':''):'暂无已结束且有记录的月份；本月尚在积累'):'已记录 '+recorded+' / '+report.days.length+' 个'+mode.label+' · '+(key==='month'?'包含同月跨日区间':'跨日区间单独列出');
      if(key==='hours'&&!recorded)el('coverage').textContent=(report.month===reports.hours.month?'今日':'所选日期')+'暂无有效采样 · 未补零';
      el('chart-title').textContent=mode.title;el('chart-count').textContent=recorded+' 个'+mode.label+'有记录';el('date-heading').textContent=mode.label;
      el('chart').style.minWidth=mode.width+'px';el('chart').replaceChildren();el('rows').replaceChildren();
      // 最高柱保持完整高度；参考线位于峰值下方，不画高于峰值的顶线。
      const peak=Math.max(0,...report.days.map(d=>d.future?0:d.mb||0)),max=peak||1;
      el('chart-max-value').textContent=amount(report.days.some(d=>!d.future&&d.mb!=null)?peak:null);
      for(const d of report.days){
        const button=document.createElement('button');button.type='button';button.className='bar';button.dataset.key=d.key;button.setAttribute('aria-label',d.key+' '+amount(d.mb));
        const fill=document.createElement('span');fill.className='fill'+(d.future?' future':d.mb==null?' missing':'');fill.style.height=(d.future?0:d.mb==null?4:Math.max(4,d.mb/max*140))+'px';
        if(d.mb>0){fill.style.background='transparent';for(const [value,color] of [[d.mainMB,'#${UF.blue}'],[d.viceMB,'#${UF.purple}'],[d.unknownMB,'#${UF.warning}']]){if(value>0){const segment=document.createElement('span');segment.className='segment';segment.style.background=color;segment.style.height=(value/d.mb*100)+'%';fill.append(segment);}}}
        const tick=document.createElement('span');tick.className='tick';tick.textContent=d.day;button.append(fill,tick);button.onclick=()=>select(d);el('chart').append(button);
        const row=document.createElement('tr');row.dataset.key=d.key;const date=document.createElement('td');const dateButton=document.createElement('button');dateButton.className='date';dateButton.textContent=key==='year'?d.key:key==='hours'?d.day+':00':d.key.slice(5);dateButton.onclick=()=>select(d);date.append(dateButton);row.append(date);
        for(const [value,className] of [[d.mainMB,'main'],[d.viceMB,'vice'],[d.unknownMB,''],[d.mb,'']]){const cell=document.createElement('td');cell.textContent=amount(value);cell.className=className;row.append(cell);}const state=document.createElement('td');state.textContent=status(d);row.append(state);el('rows').append(row);
      }
      el('cross-hint').hidden=key==='year'||!report.crossDay.length;el('cross-hint').textContent=(key==='month'?'其中跨日未分配 ':'另有跨日待分配 ')+amount(report.unallocatedMB)+' · '+report.crossDay.length+' 段，'+(key==='month'?'已计入所选月份合计':'未计入上方合计');
      el('chart-foot').textContent=key==='year'?'左右滑动查看月份，点击查看明细；灰色为无数据占位':key==='hours'?'点击时段查看明细；跨小时增量计入结束小时，不平均摊分':'左右滑动查看整月，点击日期查看明细；短柱不代表固定用量';
      el('cross-description').textContent=key==='month'?'这部分已计入所选月份合计，无法准确拆到每天，因此未计入每日柱状图。':'这部分无法准确拆到小时，未计入所选日期小时合计。';
      el('cross-card').hidden=key==='year'||!report.crossDay.length;el('cross-summary').textContent='跨日未分配 '+amount(report.unallocatedMB)+' · '+report.crossDay.length+' 段';el('cross-events').replaceChildren();
      for(const interval of report.crossDay){const item=document.createElement('div');item.className='cross-event';item.textContent=clock(interval.from,true)+' → '+clock(interval.at,true)+'\\n合计 '+amount(interval.mb)+' · 主 '+amount(interval.mainMB)+' / 副 '+amount(interval.viceMB)+' / 未确认 '+amount(interval.unknownMB);el('cross-events').append(item);}
      el('scope').textContent=key==='year'?'每根柱子表示一个月已记录的用量，不累计跨月总量。月均只对已结束且有记录的月份计算，不含本月与空白月份；部分记录月份会标注并计入已记录月均，不能当作完整账单月均。':key==='hours'?'小时图按有效区间的结束小时归集；跨日小流量近似归入对应日期，前一天归入23时。长时间没有采样时，一根柱可能包含多个小时的用量。':'顶部为所选月份已记录用量，包含同日和可确认的同月跨日区间，与趋势图中对应月份的柱子一致。跨日小流量近似归入覆盖时间较长的一天，其余跨日用量单独保存，因此每日柱子的合计可能低于所选月份顶部合计。';
      el('updated').textContent='最后成功查询 '+clock(report.lastSuccess,true)+'\\n切换视图使用同一份记录，不额外查询';
      select(report.days.find(d=>d.key===report.today)||report.days[report.days.length-1]);
    }
    const queryLog=reports.refresh||{rows:[],count:0,average:null,longest:null};
    const duration=ms=>ms==null?'—':ms<60000?Math.max(1,Math.round(ms/1000))+' 秒':(Math.round(ms/6000)/10)+' 分钟';
    el('refresh-count').textContent=queryLog.count+' 次';el('refresh-average').textContent=duration(queryLog.average);el('refresh-longest').textContent=duration(queryLog.longest);
    const executionRows=queryLog.entries||queryLog.rows;
    el('refresh-empty').hidden=executionRows.length>0;
    el('refresh-execution-summary').textContent='实际查询成功 '+queryLog.count+' 次 · 使用缓存 '+(queryLog.cached||0)+' 次 · 执行失败 '+(queryLog.failed||0)+' 次。上方平均与最长间隔仅计算成功查询。';
    el('clear-refresh-records').onclick=()=>{location.href='unicomflow://clear-refresh-records';};
    const sourceName=source=>source&&source.startsWith('widget-')?'小组件 · '+(source.includes('-small-')?'小号':'中号')+' · '+(source.endsWith('-today')?'今日':'当月')
      :({script:'运行脚本',preview:'组件预览',statistics:'用量统计',manual:'手动刷新',connection:'连接检查',diagnostics:'成员检查'})[source]||'来源未知';
    for(const item of executionRows){
      const row=document.createElement('tr'),time=document.createElement('td'),source=document.createElement('td'),status=document.createElement('td'),gap=document.createElement('td');
      time.textContent=clock(item.at,true);source.textContent=sourceName(item.source);
      status.textContent=item.state==='cache'?'使用缓存 · 未请求联通':item.state==='failed'?'执行失败':item.reason==='forced'?'查询成功 · 强制':item.reason==='midnight'?'查询成功 · 跨日':item.reason==='no-cache'?'查询成功 · 无缓存':'查询成功';
      gap.textContent=item.state==='cache'||item.state==='failed'?'—':duration(item.interval);
      row.append(time,source,status,gap);el('refresh-rows').append(row);
    }
    let showingRefresh=false, usageScroll=0;
    el('refresh-records-toggle').onclick=()=>{
      if(!showingRefresh)usageScroll=typeof scrollY==='number'?scrollY:0;
      showingRefresh=!showingRefresh;el('refresh-records').hidden=!showingRefresh;el('usage-content').hidden=showingRefresh;
      el('refresh-records-toggle').textContent=showingRefresh?'返回统计':'刷新记录';el('refresh-records-toggle').setAttribute('aria-expanded',String(showingRefresh));
    el('page-title').textContent=showingRefresh?'刷新记录':'用量统计';el('page-subtitle').textContent=showingRefresh?'执行来源 · 查询与缓存':'采样记录 · 非运营商账单';
      if(typeof scrollTo==='function')scrollTo(0,showingRefresh?0:usageScroll);
    };
    // 禁止双击缩放，但不拦截 touchmove，保留图表和表格的正常滚动。
    document.addEventListener('dblclick',event=>event.preventDefault(),{passive:false});
    el('period-prev').onclick=()=>changePeriod(-1);el('period-next').onclick=()=>changePeriod(1);
    el('period-select').onchange=()=>{const key=el('period-select').value;if(current!=='year'&&periodChoices(current).includes(key)){selections[current]=key;render(current);}};
    Object.keys(modes).forEach(key=>el('tab-'+key).onclick=()=>render(key));render(Object.hasOwn(modes,initial)&&reports[initial]?initial:reports.hours?'hours':'month');
    if(${showRefresh === true})el('refresh-records-toggle').onclick();
  })();</script></body></html>`;
}

function updateHistory(previous, sample) {
  const old = previous && previous.version === 1 && previous.cardHistoryVersion === 1 && previous.session === sample.session ? previous : {};
  let events = Array.isArray(old.events) ? old.events.filter(e =>
    Number.isFinite(e.at) && e.at <= sample.at && e.at >= sample.at - 7 * 86400000)
    .map(({ packageDeltas, ...event }) => event) : []; // 清理上一版冗余字段，保留原有逐卡历史。
  const prev = old.last;
  if (prev && sample.at <= prev.at) return old;
  let note = '正在积累数据', interval = null;
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
      interval = { from: prev.at, at: sample.at, mb: delta, ...cardDelta(prev, sample) };
      const assignedAt = smallCrossDayTime(interval);
      if (assignedAt != null) interval.assignedAt = assignedAt;
      if (eventDate(interval)) events.push(interval);
      note = '今日区间增量 · 按采样时刻';
    } else { events = []; note = '计数回退，重新积累'; }
  } else if (prev) { events = []; note = '套餐或月份变化，重新积累'; }
  const months = updateMonths(old.months, sample, prev, interval, note);
  return { version: 1, cardHistoryVersion: 1, session: sample.session, events, months, note,
    ...(Number.isFinite(old.queryLogClearedAt) ? { queryLogClearedAt: old.queryLogClearedAt } : {}),
    queryTimes: [...new Set([...successfulQueryTimes(old, sample.at), sample.at])]
      .filter(time => Number.isFinite(time) && time <= sample.at && time >= sample.at - 7 * 86400000).sort((a, b) => a - b),
    last: { at: sample.at, signature, packages: sample.packages, members: (sample.members || []).map(m => ({ id: m.id, role: m.role, roleConflict: m.roleConflict })) }, data: sample };
}

function todayBuckets(history, at) {
  const buckets = Array.from({ length: 24 }, () => ({ mb: 0, mainMB: 0, viceMB: 0, unknownMB: 0, samples: 0 }));
  for (const event of history.events || []) {
    if (eventDate(event) !== dayKey(at)) continue;
    const bucket = buckets[new Date(event.assignedAt == null ? event.at : event.assignedAt).getHours()];
    bucket.mb += event.mb;
    for (const [key, value] of Object.entries(eventParts(event))) bucket[key] += value;
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
    remove(name) { const path = fm.joinPath(dir, name + '.json'); if (fm.fileExists(path)) fm.remove(path); },
    usage() {
      const files = [];
      const visit = (path, prefix = '') => {
        for (const name of fm.listContents(path)) {
          const file = fm.joinPath(path, name), label = prefix + name;
          if (fm.isDirectory(file)) visit(file, label + '/');
          else files.push({ name: label, kb: fm.fileSize(file) });
        }
      };
      visit(dir);
      return { files, kb: files.every(file => Number.isFinite(file.kb)) ? files.reduce((sum, file) => sum + file.kb, 0) : null };
    },
    clear() { this.remove('history'); this.remove('refresh-log'); },
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
  // 先按成功抓包中的表单请求；失败时退回不带表单的旧请求。
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

function queryDeadline(history) {
  const at = history && history.data && history.data.at;
  if (!Number.isFinite(at)) return null;
  const midnight = new Date(at); midnight.setHours(24,0,0,0);
  return Math.min(at + UF.dataRequestMinutes * 60000, midnight.getTime());
}

function reusableHistory(history, session, now) {
  return history && history.version === 1 && history.cardHistoryVersion === 1 && history.session === session
    && history.data && Number.isFinite(history.data.at) && history.data.at <= now && now < queryDeadline(history);
}

function pauseQuery(ms) {
  return new Promise(resolve => Timer.schedule(ms, false, resolve));
}

async function refresh(store, force = false, source = 'script') {
  const saveExecution = (state, result) => {
    const now = Date.now(), dataAt = result && result.history.data.at;
    const entry = { at: state === 'query' ? dataAt : now, source, state, forced: force,
      ...(result && result.reason ? { reason: result.reason } : {}),
      ...(Number.isFinite(dataAt) ? { dataAt } : {}) };
    // 独立轻量日志，缓存命中不重写整份流量历史；限制保留时间与条数。
    const log = (store.read('refresh-log', []) || []).filter(item => Number.isFinite(item.at) && item.at >= now - 7 * 86400000 && item.at <= now);
    log.push(entry); store.write('refresh-log', log.slice(-2000));
  };
  let result;
  try { result = await queryWithCache(store, force); }
  catch (error) { try { saveExecution('failed'); } catch (_) {} throw error; }
  try { saveExecution(result.fromCache ? 'cache' : 'query', result); } catch (_) {}
  return result;
}

async function queryWithCache(store, force = false) {
  const started = Date.now();
  // 每次核对当前 Cookie，避免缓存命中后掩盖换号；仅联通查询共用缓存。
  const cookie = await readCookie(), session = sessionTag(cookie);
  const previous = store.read('history', null);
  if (previous && previous.session !== session) store.clear();
  if (!force && reusableHistory(previous, session, Date.now())) return { history: previous, stale: false, error: '', fromCache: true };
  const reason = force ? 'forced' : previous && previous.session === session && previous.data
    ? dayKey(previous.data.at) !== dayKey(Date.now()) ? 'midnight' : 'interval' : 'no-cache';
  const owner = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  let waited = false;
  // 临时请求锁只存标识和过期时间，不保存 Cookie；查询结束删除，异常退出后30秒失效。
  for (let i = 0; i < 32; i++) {
    const latest = store.read('history', null);
    if ((!force || waited) && reusableHistory(latest, session, Date.now()) && (!force || latest.data.at >= started)) {
      return { history: latest, stale: false, error: '', fromCache: true };
    }
    const pending = store.read('query-lock', null);
    if (pending && pending.expiresAt > Date.now()) { waited = true; await pauseQuery(250); continue; }
    store.write('query-lock', { owner, expiresAt: Date.now() + 30000 });
    // 写入后让同时启动的组件先合并，再确认自己仍是本次请求的持有者。
    await pauseQuery(80);
    if ((store.read('query-lock', {}) || {}).owner !== owner) { waited = true; continue; }
    try {
      const data = await fetchData(cookie, store.read('categories', {}));
      const sample = { ...data, at: Date.now(), session };
      const history = updateHistory(store.read('history', null), sample);
      store.write('history', history);
      return { history, stale: false, error: '', fromCache: false, reason };
    } finally {
      if ((store.read('query-lock', {}) || {}).owner === owner) store.remove('query-lock');
    }
  }
  throw new Error('其他组件正在查询，请稍后再试');
}

// ---- 所有布局均由 Scriptable 原生绘图生成 ----
function numberFont(size, kind = 'usage') {
  const font = normalizedNumberFont(UF[kind + 'Font']);
  if (font === '系统 Regular') return Font.systemFont(size);
  if (font === '系统 Medium') return Font.mediumSystemFont(size);
  if (font === 'SF Mono Medium') return Font.mediumMonospacedSystemFont(size);
  if (font === 'Menlo Regular') {
    try { return new Font('Menlo-Regular', size) || Font.regularMonospacedSystemFont(size); }
    catch (_) { return Font.regularMonospacedSystemFont(size); }
  }
  return Font.regularMonospacedSystemFont(size);
}

// 绘图接口没有文字测量能力，按偏保守的字符宽度给数字与单位分配空间。
function numberWidth(value, size, kind) {
  const system = normalizedNumberFont(UF[kind + 'Font']).startsWith('系统');
  return [...value].reduce((sum, ch) => sum + (/[\u3400-\u9fff]/.test(ch) ? 1 : system ? (ch === '.' || ch === ' ' ? 0.28 : ch === '/' ? 0.30 : /[0-9]/.test(ch) ? 0.60 : 0.66) : 0.62), 0) * size;
}

function text(ctx, value, x, y, width, height, size, color = UF.text, mono = false, centered = false, medium = false) {
  ctx.setTextColor(new Color(color));
  ctx.setFont(mono === 'number' || mono === 'total' ? numberFont(size, mono === 'total' ? 'total' : 'usage') : mono ? Font.regularMonospacedSystemFont(size) : medium ? Font.mediumSystemFont(size) : Font.systemFont(size));
  if (centered === 'right') ctx.setTextAlignedRight(); else if (centered) ctx.setTextAlignedCenter(); else ctx.setTextAlignedLeft();
  ctx.drawTextInRect(value, new Rect(x, y, width, height));
}

function roundedRect(ctx, x, y, w, h, radius, color) {
  if (w <= 0 || h <= 0) return;
  const path = new Path();
  path.addRoundedRect(new Rect(x, y, w, h), Math.min(radius, w / 2), Math.min(radius, h / 2));
  ctx.setFillColor(new Color(color));
  ctx.addPath(path);
  ctx.fillPath();
}

function drawMetric(ctx, metric, label, x, y, width, compact, today = false, dailyUsed = null) {
  const title = ['通用', '定向'].includes(label) ? '数据流量·' + label : label;
  const heading = today ? title + ' · 今日' : title;
  const headingWidth = [...heading].reduce((sum,ch) => sum + (/[\u3400-\u9fff]/.test(ch) ? 1 : 0.6),0);
  const headingSize = Math.min(UF.titleFontSize == null ? compact ? 10 : 11 : UF.titleFontSize, width / Math.max(1,headingWidth));
  text(ctx, heading, x, y, width, 16, headingSize, UF.text, false, false, true);
  const primary = formatMB(today ? dailyUsed : metric && metric.used, today ? 'daily' : 'usage');
  const textX = x + 10, textWidth = width - 10;
  // 等宽字体的普通空格过宽，数字与单位分开绘制，同字号并只留 2 点间距。
  const parts = primary.match(/^(.*?)(MB|GB)$/);
  if (parts) {
    const gap = 2;
    const size = Math.min(UF.usageFontSize, (textWidth - gap) / Math.max(1, numberWidth(parts[1] + parts[2], 1, 'usage')));
    const unitX = textX + numberWidth(parts[1], size, 'usage') + gap;
    text(ctx, parts[1], textX, y + 14, unitX - textX, 30, size, UF.text, 'number');
    text(ctx, parts[2], unitX, y + 14, Math.max(1, textX + textWidth - unitX), 30, size, UF.text, 'number');
  } else {
    text(ctx, primary, textX, y + 14, textWidth, 30, UF.usageFontSize, UF.text, 'number');
  }
  let detail = '未返回明细';
  if (metric) detail = metric.detail || (metric.total == null ? '不限量' : `${formatMB(metric.total, 'total')}(${metric.total > 0 ? Math.round(metric.used / metric.total * 100) : '--'}%)`);
  if (today && metric) detail = metric.total == null ? `${formatGB(metric.used)} GB / 不限量` : `${formatGB(metric.used)}/${formatGB(metric.total, true)}GB`;
  const totalParts = detail.match(/^(.*?)(MB|GB)(.*)$/);
  if (today && metric && metric.total != null) {
    const runs = [formatGB(metric.used), '/', formatGB(metric.total, true), 'GB'];
    const gap = 2;
    const size = Math.min(UF.totalFontSize, (textWidth - gap * (runs.length - 1))
      / Math.max(1, runs.reduce((sum, run) => sum + numberWidth(run, 1, 'total'), 0)));
    let runX = textX;
    for (const run of runs) {
      const runWidth = numberWidth(run, size, 'total');
      text(ctx, run, runX, y + 44, runWidth + gap, 16, size, UF.muted, 'total');
      runX += runWidth + gap;
    }
  } else if (totalParts) {
    const gap = 2;
    const size = Math.min(UF.totalFontSize, (textWidth - gap) / Math.max(1, numberWidth(detail, 1, 'total')));
    const unitX = textX + numberWidth(totalParts[1], size, 'total') + gap;
    text(ctx, totalParts[1], textX, y + 44, unitX - textX, 16, size, UF.muted, 'total');
    text(ctx, totalParts[2] + totalParts[3], unitX, y + 44, Math.max(1, textX + textWidth - unitX), 16, size, UF.muted, 'total');
  } else {
    const detailSize = Math.min(UF.totalFontSize, textWidth / Math.max(1, numberWidth(detail, 1, 'total')));
    text(ctx, detail, textX, y + 44, textWidth, 16, detailSize, metric ? UF.muted : UF.warning, 'total');
  }
  const barY = y + 18, barH = 37, barW = 5;
  // 小圆角矩形：横纵圆角相同，短彩条也保留平直边缘。
  const bar = (top, height, color) => roundedRect(ctx, x, top, barW, height, Math.min(barW, height) / 4, color);
  bar(barY, barH, UF.track);
  if (metric && metric.composition) {
    const c = metric.composition;
    // 彩条按套餐总量分别表示主副卡已用量，未用部分保留灰色。自底部向上增长，超额时按已用构成缩放至条高。
    if (c.complete && metric.used > 0 && metric.total > 0) {
      const scale = barH / Math.max(metric.total, c.main + c.vice);
      const mainHeight = c.main * scale, viceHeight = c.vice * scale;
      if (c.main > 0) bar(barY + barH - mainHeight, mainHeight, UF.blue);
      if (c.vice > 0) bar(barY + barH - mainHeight - viceHeight, viceHeight, UF.purple);
    }
    if (!today && !(c.complete && c.main === 0)) {
      const half = width / 2;
      roundedRect(ctx, x, y + 63, 2.5, 2.5, 1.25, UF.blue);
      roundedRect(ctx, x + half, y + 63, 2.5, 2.5, 1.25, UF.purple);
      text(ctx, `主 ${formatMB(c.main)}`, x + 5, y + 60, half - 5, 10, compact ? 6 : 6.5, UF.muted);
      text(ctx, `副 ${formatMB(c.vice)}`, x + half + 5, y + 60, half - 5, 10, compact ? 6 : 6.5, UF.muted);
    }
  } else if (metric && metric.total > 0) {
    const ratio = Math.min(1, Math.max(0, metric.used / metric.total));
    bar(barY + barH * (1 - ratio), barH * ratio, UF.blue);
  }
}

function renderImage(result, medium, width, height, mode = 'month') {
  // 统一为 158 点设计高度，再随组件尺寸缩放，避免小屏沿用固定坐标而挤入圆角。
  width = Math.round(width * 158 / height);
  height = 158;
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.respectScreenScale = true;
  ctx.opaque = true;
  ctx.setFillColor(new Color(UF.bg));
  ctx.fillRect(new Rect(0, 0, width, height));
  const data = result.history.data, pad = 13;
  const metrics = displayMetrics(data);
  const today = widgetMode(mode) === 'today';
  // 共享逐卡月明细出现时保留安全间隔；其余布局利用留白向上增高，底边固定。
  const chartLift = !today && [metrics.left, metrics.right].some(metric => metric && metric.composition
    && !(metric.composition.complete && metric.composition.main === 0)) ? 0 : 6;
  const daily = today ? [todayPackageUsage(result.history, metrics.leftIds, Date.now()), todayPackageUsage(result.history, metrics.rightIds, Date.now())] : [];
  const now = Date.now();
  const buckets = !medium ? [] : today ? todayBuckets(result.history, now)
    : monthlyReport(result.history, now).days.map(day => ({ mb: day.mb || 0, ...eventParts({ ...day, mb: day.mb || 0 }), samples: day.intervals }));
  if (medium) {
    const col = (width - 2 * pad - 20) / 2;
    drawMetric(ctx, metrics.left, metrics.leftLabel, pad, 12, col, false, today, daily[0]);
    drawMetric(ctx, metrics.right, metrics.rightLabel, pad + col + 20, 12, col, false, today, daily[1]);
    const chartX = pad, chartY = 99 - chartLift, chartW = width - 2 * pad, chartH = height - chartY - 30;
    const currentSlot = today ? new Date(now).getHours() : new Date(now).getDate() - 1;
    const visibleBuckets = buckets.slice(0, currentSlot + 1);
    const peak = Math.max(0, ...visibleBuckets.map(bucket => bucket.mb));
    const cell = chartW / buckets.length, max = Math.max(1, peak);
    const markers = today ? [0, 6, 12, 18, 23] : [0, 4, 9, 14, 19, 24, buckets.length - 1];
    const minimumBar = 1.5;
    text(ctx, today ? '小时用量' : '每日用量',
      chartX, 84 - chartLift, chartW - 110, 12, 8, UF.muted);
    const peakLabel = visibleBuckets.some(bucket => bucket.samples)
      ? formatMB(peak, 'daily').replace(/(MB|GB)$/, ' $1') : '—';
    text(ctx, `MAX ${peakLabel}`, chartX + chartW - 110, 84 - chartLift, 110, 12, 8, UF.muted, false, 'right');
    buckets.forEach((bucket, slot) => {
      const center = chartX + (slot + 0.5) * cell;
      const barWidth = Math.max(1, cell - 4.5);
      ctx.setFillColor(new Color(markers.includes(slot) ? UF.gridMajor : UF.gridMinor));
      ctx.fillRect(new Rect(center - 0.25, chartY, 0.5, chartH));
      if (slot > currentSlot) return;
      if (bucket.mb > 0) {
        const h = Math.max(minimumBar, bucket.mb / max * chartH);
        let bottom = chartY + chartH;
        for (const [value, color] of [[bucket.mainMB, UF.blue], [bucket.viceMB, UF.purple], [bucket.unknownMB, UF.warning]]) {
          if (value <= 0) continue;
          const height = h * value / bucket.mb;
          bottom -= height; ctx.setFillColor(new Color(color));
          ctx.fillRect(new Rect(center - barWidth / 2, bottom, barWidth, height));
        }
      } else if (bucket.samples || slot < currentSlot) {
        // 灰色是缺少采样的占位，不计入用量；紫色短柱表示真实零增量。
        ctx.setFillColor(new Color(bucket.samples ? UF.purple : UF.track));
        ctx.fillRect(new Rect(center - barWidth / 2, chartY + chartH - minimumBar, barWidth, minimumBar));
      }
    });
    markers.forEach(h => text(ctx, today ? String(h).padStart(2, '0') : String(h + 1), chartX + (h + 0.5) * cell - 9, chartY + chartH + 2, 18, 10, 7, UF.muted, true, true));
  } else {
    drawMetric(ctx, metrics.left, metrics.leftLabel, pad, 12, width - 2 * pad, true, today, daily[0]);
    drawMetric(ctx, metrics.right, metrics.rightLabel, pad, 84, width - 2 * pad, true, today, daily[1]);
  }
  const date = new Date(data.at);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  const incomplete = [metrics.left, metrics.right].some(metric => metric && metric.composition && !metric.composition.complete);
  const status = result.stale ? `缓存 ${dayKey(data.at).slice(5)} · 查询未成功`
    : incomplete ? '逐卡明细未补全 · 暂不分色' : data.warnings.length || metrics.omitted ? '另有明细 · 点击查看' : '';
  const compactStatus = result.stale ? `缓存 ${dayKey(data.at).slice(5)}`
    : incomplete ? '逐卡明细不全' : status ? '另有明细' : '';
  const label = medium ? status ? `${time} · ${status}` : `${result.manualRefresh ? '已刷新' : '更新'} ${time}`
    : compactStatus ? `${time} · ${compactStatus}` : `${result.manualRefresh ? '已刷新' : '更新'} ${time}`;
  // 图例解释整张卡片，置于底部右侧；左侧预留更新时间及异常提示。
  const footerY = height - (medium ? 18 : 15);
  const dailyHint = today && !status && !daily.some(value => value != null)
    ? (todayBuckets(result.history, now).some(b => b.samples) ? '今日分类未确认' : '今日待采样') : '';
  text(ctx, dailyHint ? `${dailyHint} · ${label}` : label, pad + 2, footerY,
    width - 2 * pad - 4 - (medium ? 62 : 0), 9, 6.5,
    result.stale || data.warnings.length || metrics.omitted || incomplete ? UF.warning : UF.muted);
  if (medium) {
    const legendX = width - pad - 54;
    [{ color: UF.blue, caption: '主卡' }, { color: UF.purple, caption: '副卡' }].forEach(({ color, caption }, index) => {
      const x = legendX + index * 30;
      roundedRect(ctx, x, footerY + 3, 2.5, 2.5, 1.25, color);
      text(ctx, caption, x + 5, footerY, 19, 9, 6.5, UF.muted);
    });
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

function makeWidget(result, medium, mode = 'month') {
  const widget = new ListWidget();
  widget.backgroundColor = new Color(UF.bg);
  widget.setPadding(0, 0, 0, 0);
  const now = Date.now();
  const nextRender = now + UF.refreshMinutes * 60000;
  widget.refreshAfterDate = new Date(result.stale ? now + 5 * 60000
    : Math.max(now + 1000, Math.min(nextRender, queryDeadline(result.history) || nextRender)));
  const size = widgetSize(medium);
  // 整卡背景由系统适配尺寸，不再放置固定宽度图片，避免图片边缘露出细线。
  widget.backgroundImage = renderImage(result, medium, size.width, size.height, mode);

  return widget;
}

function errorWidget(message, medium = false) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color(UF.bg);
  widget.setPadding(15, 15, 15, 15);
  const title = widget.addText('联通流量'); title.textColor = new Color(UF.text); title.font = Font.boldSystemFont(16);
  widget.addSpacer(10);
  const msg = widget.addText(message); msg.textColor = new Color(UF.warning); msg.font = Font.systemFont(11);
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
  b.message = `已用 ${formatMB(p.used)} / 总量 ${p.unlimited ? '不限量' : formatMB(p.total, 'total')}`;
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
  try { new Function('return (async () => {\n' + source + '\n})'); }
  catch (_) { throw new Error('下载脚本语法检查未通过，未替换当前文件'); }
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

// DmYY 负责分组配置页，预览由本脚本统一生成，Cookie 仍逐项直读。
function createWidgetClass(DmYY) {
  return class UnicomFlowWidget extends DmYY {
    constructor(arg) {
      super(arg);
      this.flowMode = widgetMode(arg);
      // 已有数字字体迁移到两个独立选项，不改变历史数据。
      let changed = false;
      if (Object.prototype.hasOwnProperty.call(this.settings, 'displayMode')) {
        delete this.settings.displayMode; changed = true;
      }
      for (const kind of ['usage', 'total']) {
        const key = kind + 'Font';
        const font = normalizedNumberFont(this.settings[key] || this.settings.numberFont, UF_DEFAULTS[key]);
        if (this.settings[key] !== font) { this.settings[key] = font; changed = true; }
      }
      // 只迁移上一版完整默认组合；用户已改过任一项时保留整组选择。
      if (!this.settings.mediumTypographyDefaultsApplied) {
        const previousDefault = this.settings.usageFont === 'SF Mono Regular' && this.settings.totalFont === 'SF Mono Regular'
          && (this.settings.usageFontSize == null || String(this.settings.usageFontSize) === '22')
          && (this.settings.totalFontSize == null || String(this.settings.totalFontSize) === '10');
        if (previousDefault) {
          for (const key of ['usageFont', 'totalFont', 'usageFontSize', 'totalFontSize']) this.settings[key] = String(UF_DEFAULTS[key]);
        }
        this.settings.mediumTypographyDefaultsApplied = true;
        changed = true;
      }
      if (changed) this.saveSettings(false);
      this.name = '联通流量';
      this.en = 'UnicomFlow';
      this.store = storage();
      this.result = null;
      this.failure = '';
      applyTheme(this.settings);
      if (!this.settings.refreshAfterDate) this.settings.refreshAfterDate = String(UF_DEFAULTS.refreshMinutes);
      // 原间隔同时控制请求和组件，升级时保留用户已设置的查询频率。
      if (this.settings.dataRequestMinutes == null) this.settings.dataRequestMinutes = this.settings.refreshAfterDate;
      if (config.runsInApp) this.registerMenus();
    }

    applySettings() {
      const domain = String(this.settings.flowBoxjsDomain || this.baseSettings.boxjsDomain || 'boxjs.net').trim();
      if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(domain)) throw new Error('BoxJS 域名格式不正确，请只填写域名，例如 boxjs.net');
      UF.boxjs = 'http://' + domain;
      const minutes = Number(this.settings.refreshAfterDate);
      UF.refreshMinutes = Number.isFinite(minutes) && minutes >= 5 && minutes <= 1440 ? minutes : UF_DEFAULTS.refreshMinutes;
      this.settings.refreshAfterDate = String(UF.refreshMinutes);
      const requestMinutes = Number(this.settings.dataRequestMinutes);
      UF.dataRequestMinutes = Number.isFinite(requestMinutes) && requestMinutes >= 5 && requestMinutes <= 1440
        ? requestMinutes : UF_DEFAULTS.dataRequestMinutes;
      this.settings.dataRequestMinutes = String(UF.dataRequestMinutes);
      const crossLimit = Number(this.settings.crossDayLimitMB == null ? UF_DEFAULTS.crossDayLimitMB : this.settings.crossDayLimitMB);
      UF.crossDayLimitMB = Number.isFinite(crossLimit) && crossLimit >= 0 && crossLimit <= 1024 ? crossLimit : UF_DEFAULTS.crossDayLimitMB;
      applyTheme(this.settings);
      UF.titleFontSize = normalizedTitleSize(this.settings.titleFontSize);
      for (const kind of ['usage', 'total']) {
        UF[kind + 'Font'] = normalizedNumberFont(this.settings[kind + 'Font'], UF_DEFAULTS[kind + 'Font']);
        UF[kind + 'FontSize'] = normalizedFontSize(this.settings[kind + 'FontSize'], kind);
      }
    }

    async loadResult(force = false, source = config.runsInWidget ? `widget-${this.widgetFamily}-${this.flowMode}` : 'script') {
      this.result = null;
      this.failure = '';
      try {
        this.applySettings();
        const saved = this.store.read('history', null), migrated = migrateSmallCrossDays(saved);
        if (migrated !== saved) this.store.write('history', migrated);
        this.result = await refresh(this.store, force, source);
      }
      catch (error) {
        this.failure = error.message || '查询失败';
        const old = this.store.read('history', null);
        if (old && old.version === 1 && old.cardHistoryVersion === 1 && old.data) this.result = { history: old, stale: true, error: this.failure };
      }
      return this.result;
    }

    async render() {
      if (!['small', 'medium'].includes(this.widgetFamily)) return errorWidget('请添加小号或中号组件');
      await this.loadResult();
      return this.result ? makeWidget(this.result, this.widgetFamily === 'medium', this.flowMode) : errorWidget(this.failure, this.widgetFamily === 'medium');
    }

    // 保留独立尺寸渲染方法，主菜单统一使用同页预览。
    async renderSmall() { this.widgetFamily = 'small'; return this.render(); }
    async renderMedium() { this.widgetFamily = 'medium'; return this.render(); }

    async showPreview() {
      await this.loadResult(false, 'preview');
      if (!this.result) return alertMessage('组件预览', this.failure || '请先成功查询一次套餐');
      const sizes = { small: widgetSize(false), medium: widgetSize(true) }, images = {};
      for (const mode of ['month', 'today']) {
        images[mode] = {};
        for (const [size, dimensions] of Object.entries(sizes)) {
          const image = renderImage(this.result, size === 'medium', dimensions.width, dimensions.height, mode);
          images[mode][size] = 'data:image/png;base64,' + Data.fromPNG(image).toBase64String();
        }
      }
      const view = new WebView();
      await view.loadHTML(previewHTML(images, sizes, this.flowMode, this.result.stale));
      await view.present();
    }

    async renderAppView(options) {
      // DmYY 自动添加的分尺寸入口由统一预览替代，不修改共享依赖。
      options = options.filter(group => !(group.title === '预览组件' && group.menu
        && group.menu.some(item => ['small', 'medium', 'large'].includes(item.name))));
      // 统一清理 DmYY 配置页的样式来源页脚，包含主菜单和全部子菜单。
      // 只调整本组件页面，不改动共享依赖或源码中的来源说明。
      const view = new WebView();
      const cleanView = new Proxy(view, {
        get(target, key) {
          if (key === 'loadHTML') return (html, ...args) => target.loadHTML(
            html.replace(/<div\s+class=["']copyright["'][^>]*>[\s\S]*?<\/div>\s*<\/div>/gi, ''), ...args);
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return super.renderAppView(options, false, cleanView);
    }

    async checkAndUpdateScript() {
      try {
        const request = new Request(UF_UPDATE_URL + '?t=' + Date.now());
        request.timeoutInterval = 15;
        const source = await request.loadString();
        validateUpdateSource(source);
        const path = module.filename;
        const local = FileManager.local();
        const cloud = local.isFileStoredIniCloud(path);
        const fm = cloud ? FileManager.iCloud() : local;
        if (cloud) await fm.downloadFileFromiCloud(path);
        if (!fm.fileExists(path)) throw new Error('找不到当前脚本文件，已取消更新');
        if (fm.readString(path) === source) return alertMessage('已是最新', '当前脚本与仓库内容一致，无需更新。');
        installUpdate(fm, path, source);
        await alertMessage('同步完成', '已同步仓库最新版，关闭配置页后重新运行即可。');
      } catch (error) {
        await alertMessage('更新未完成', error.message || '下载失败，请稍后再试');
      }
    }

    async refreshFromQX() {
      await this.loadResult(true, 'manual');
      await alertMessage(this.failure ? '刷新未完成' : '刷新完成', this.failure || '已读取 QX 保存的 Cookie 并查询最新流量数据，共享记录已更新。桌面组件的重绘时间由 iOS 决定。');
    }

    async showUsageStatistics(showRefresh = false) {
      await this.loadResult(false, 'statistics');
      if (!this.result) return alertMessage('用量统计', this.failure || '请先成功查询一次套餐');
      const view = new WebView();
      await view.loadHTML(statisticsHTML(statisticsReports(this.result.history, Date.now(), this.store.read('refresh-log', [])), this.result.stale, 'hours', showRefresh));
      let clearing = false;
      const stale = this.result.stale;
      view.shouldAllowRequest = request => {
        if (request.url !== 'unicomflow://clear-refresh-records') return true;
        if (!clearing) {
          clearing = true;
          this.clearHistoryPart('refresh').then(async cleared => {
            if (!cleared) return;
            const history = this.store.read('history', null);
            if (history && history.data) await view.loadHTML(statisticsHTML(statisticsReports(history, Date.now(), this.store.read('refresh-log', [])), stale, 'hours', true));
          }).catch(error => alertMessage('清除未完成', error.message || '请重试')).finally(() => { clearing = false; });
        }
        return false;
      };
      await view.present();
    }

    async memberDiagnostics() {
      await this.loadResult(false, 'diagnostics');
      const report = this.result && this.result.history.data.memberReport;
      if (!report) return alertMessage('成员字段检查', this.failure || '尚无结构报告，请先刷新数据');
      const a = new Alert(); a.title = '成员字段检查';
      a.message = (this.result.stale ? '当前为缓存报告。\n' : '') + report;
      a.addAction('复制报告'); a.addCancelAction('关闭');
      if (await a.presentAlert() === 0) Pasteboard.copyString(report);
    }

    async connectionStatus() {
      await this.loadResult(true, 'connection');
      await alertMessage('连接检查', this.failure || `QX Cookie：已读取\n套餐接口：成功\n识别流量包：${this.result.history.data.packages.length}\n${this.result.history.data.warnings.join('\n')}\n\nCookie 未写入文件或日志。`);
    }

    async clearHistoryPart(part, scope = null) {
      const descriptions = {
        snapshot: ['最新套餐快照', '清除最新套餐数据及增量计算基线，下次查询重新建立基线；这段间隔的用量不再计算。保留已有短期采样、每日用量记录及刷新记录。'],
        refresh: ['刷新记录', '清除查询时间、触发来源、缓存及失败执行记录和间隔统计，保留用量记录及最新套餐数据。旧采样时间不会重新出现在刷新记录中。'],
        hours: ['小时用量记录', '清除最近7天采样区间，单日小时图及今日用量将从后续采样重新积累。保留刷新记录、每日用量记录及最新套餐数据。'],
        months: ['每日用量记录', '清除近12个月每日用量记录和跨日记录，单月及月度趋势从后续采样重新积累。保留小时用量记录、刷新记录及最新套餐数据。'],
        all: ['全部历史', '清除最新套餐快照、小时用量记录、每日用量记录及刷新记录，下次查询重新建立基线。'],
      };
      if (!descriptions[part]) return;
      if (scope != null && !(part === 'hours' && /^\d{4}-\d{2}-\d{2}$/.test(scope)
        || part === 'months' && /^\d{4}-\d{2}$/.test(scope))) return;
      let [title, description] = descriptions[part];
      if (scope != null) {
        title = `${scope} 的${title}`;
        description = part === 'hours' ? `仅清除 ${scope} 的采样区间，对应日期的小时图及今日用量将缺少这些明细。保留其他日期采样、每日用量记录、刷新记录及套餐快照。`
          : `仅清除 ${scope} 的每日用量记录及该月保存的跨日记录。保留其他月份汇总、小时用量记录、刷新记录及套餐快照。若为当前月，后续采样仍会继续记录该月的新用量。`;
      }
      const confirm = new Alert(); confirm.title = `清除${title}？`; confirm.message = description + '\nQX Cookie 和组件设置保留。';
      confirm.addDestructiveAction('清除'); confirm.addCancelAction('取消');
      if (await confirm.presentAlert() !== 0) return;
      const history = this.store.read('history', null);
      if (part === 'refresh') this.store.remove('refresh-log');
      if (part === 'all') this.store.clear();
      else if (history) {
        // 删除小时明细前保留可恢复的查询时间，两个功能可独立清理。
        history.queryTimes = successfulQueryTimes(history, Date.now());
        if (part === 'snapshot') { delete history.data; delete history.last; }
        if (part === 'refresh') { history.queryTimes = []; history.queryLogClearedAt = Date.now(); }
        if (part === 'hours') history.events = scope == null ? [] : (history.events || []).filter(event => eventDate(event) !== scope);
        if (part === 'months') {
          if (scope == null) history.months = {};
          else if (history.months) delete history.months[scope];
        }
        this.store.write('history', history);
      }
      this.result = null;
      await alertMessage('清除完成', `已清除${title}。`);
      return true;
    }

    async showStoredDetails(part) {
      if (!['hours', 'months'].includes(part)) return;
      const history = this.store.read('history', {}) || {};
      const title = part === 'hours' ? '小时用量记录' : '每日用量记录';
      const keys = part === 'hours' ? [...new Set((history.events || []).filter(event => Number.isFinite(event.at)).map(event => eventDate(event)).filter(Boolean))]
        : Object.keys(history.months || {});
      keys.sort().reverse();
      const groups = keys.map(key => {
        const saved = history.months && history.months[key];
        const count = part === 'hours' ? (history.events || []).filter(event => eventDate(event) === key).length : Object.keys(saved.days || {}).length;
        return { name: `storedGroup_${part}_${key}`, title: key,
          desc: part === 'hours' ? `${count} 段采样 · 保留每日用量记录 · 点击删除此日采样`
            : `${count} 天汇总 · ${(saved.crossDay || []).length} 段跨日记录 · 保留小时用量记录 · 点击删除此月汇总`,
          type: 'input', icon: { name: 'trash', color: '#FF3B30' }, onClick: () => this.clearHistoryPart(part, key) };
      });
      if (!groups.length) groups.push({ name: 'storedEmpty', title: '暂无记录', type: 'input', icon: { name: 'tray', color: '#8E8E93' }, onClick: () => {} });
      return this.renderAppView([{ title: `${title} · 按${part === 'hours' ? '日期' : '月份'}删除（用量详情见用量统计）`, menu: groups },
        { title: '整类清理', menu: [{ name: 'storedClearAll', title: `清除全部${title}`, desc: '删除此类数据的所有日期，操作前再次确认',
          type: 'input', icon: { name: 'trash', color: '#FF3B30' }, onClick: () => this.clearHistoryPart(part) }] }]);
    }

    async clearHistory() {
      const history = this.store.read('history', {}) || {};
      const months = Object.values(history.months || {});
      const usage = this.store.usage();
      const size = kb => !Number.isFinite(kb) ? '无法读取' : kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(2) + ' KB';
      const choices = [
        ['snapshot', '最新套餐快照', `${history.data ? '1 份' : '暂无'} · 套餐显示及下次增量计算的基线`, 'doc.text'],
        ['refresh', '刷新记录', `${successfulQueryTimes(history, Date.now()).length} 条成功查询 · 最近7天；另记触发来源及缓存结果`, 'clock.arrow.circlepath'],
        ['hours', '小时用量记录', `${(history.events || []).length} 段 · 保留最近7天，用于单日统计及今日用量；按查询区间记录，非每小时一条`, 'chart.bar.xaxis'],
        ['months', '每日用量记录', `${months.length} 个月 · ${months.reduce((n, month) => n + Object.keys(month.days || {}).length, 0)} 天 · 保留最近12个月，用于单月统计及月度趋势`, 'calendar'],
        ['all', '全部历史', '包含最新套餐快照及全部统计记录', 'trash'],
      ];
      return this.renderAppView([{ title: '存储概况', menu: [{ name: 'flowStorageSize', title: '数据文件总大小',
        defaultValue: size(usage.kb), desc: `${usage.files.length} 个文件 · 点击查看文件明细`, type: 'input', icon: { name: 'internaldrive', color: '#8E8E93' },
        onClick: () => alertMessage('数据文件明细', (usage.files.map(file => `${file.name}：${size(file.kb)}`).join('\n') || '暂无数据文件')
          + '\n\n统计范围为本脚本的数据目录，不含脚本代码、DmYY 设置和图片缓存。套餐分类设置及临时查询锁也计入文件大小；全部历史仅清除历史数据，保留分类设置。'),
      }] }, { title: '历史数据', menu: choices.filter(([part]) => !['snapshot', 'all'].includes(part)).map(([part, title, desc, icon]) => ({
        name: 'clearHistory_' + part, title, desc: desc + (part === 'hours' ? ' · 按日期管理' : part === 'months' ? ' · 按月份管理' : ' · 点击清除'),
        type: 'input', icon: { name: icon, color: ['hours', 'months'].includes(part) ? '#007AFF' : '#FF3B30' },
        onClick: () => ['hours', 'months'].includes(part) ? this.showStoredDetails(part) : this.clearHistoryPart(part),
      })) }, { title: '谨慎清理', menu: choices.filter(([part]) => ['snapshot', 'all'].includes(part)).map(([part, title, desc]) => ({
        name: 'clearHistory_' + part, title: '清除' + title, desc, type: 'input',
        icon: { name: part === 'snapshot' ? 'doc.badge.clock' : 'exclamationmark.triangle.fill', color: part === 'snapshot' ? '#FF9500' : '#FF3B30' },
        onClick: () => this.clearHistoryPart(part),
      })) }]);
    }

    async refreshSettings() {
      return this.renderAppView([{ title: '刷新设置', menu: [
        ...[
          ['refreshAfterDate', '组件刷新间隔', '默认30分钟；建议组件重新运行的间隔，实际由 iOS 调度。缓存更早到期时提前请求运行。', 'clock'],
          ['dataRequestMinutes', '数据请求间隔', '默认30分钟；所有组件共用，成功查询后在此间隔内使用缓存；立即刷新数据不受限制。', 'arrow.triangle.2.circlepath'],
        ].map(([key, title, desc, icon]) => ({ name: key, val: key, title, desc,
          type: 'input', placeholder: '30', defaultValue: String(this.settings[key] || '30'), icon: { name: icon, color: '#34C759' },
          onClick: async (_, __, view) => {
            const a = new Alert(); a.title = title; a.message = desc + '\n单位为分钟，范围 5—1440。';
            a.addTextField('30', String(this.settings[key] || '30')); a.addAction('保存'); a.addCancelAction('取消');
            if (await a.presentAlert() < 0) return;
            const n = Number(a.textFieldValue(0));
            if (!Number.isFinite(n) || n < 5 || n > 1440) return alertMessage('未保存', '请输入 5—1440 之间的分钟数');
            this.settings[key] = String(n); this.saveSettings(false);
            if (view && this.insertTextByElementId) await this.insertTextByElementId(view, key, String(n));
          } })),
      ] }]);
    }

    async fontSettings() {
      const groups = [['usage', '用量文字', 12, 28], ['total', '总量与百分比', 6, 14]];
      const sections = groups.map(([kind, title, min, max]) => ({ title, menu: [
        { name: kind + 'Font', val: kind + 'Font', title: '字体', type: 'select',
          options: Object.keys(UF_NUMBER_FONTS), defaultValue: this.settings[kind + 'Font'], icon: { name: 'textformat', color: '#007AFF' } },
        { name: kind + 'FontSize', val: kind + 'FontSize', title: '文字大小', type: 'input',
          defaultValue: String(normalizedFontSize(this.settings[kind + 'FontSize'], kind)),
          desc: `小号、中号共用；输入 ${min}—${max}，支持小数；内容过宽时自动缩小`,
          icon: { name: 'textformat.size', color: '#007AFF' },
          onClick: async (_, __, view) => {
            const key = kind + 'FontSize';
            const a = new Alert(); a.title = title + '大小';
            a.message = `小号、中号共用。请输入 ${min}—${max} 之间的字号，支持小数；内容过宽时自动缩小。`;
            a.addTextField(String(UF_DEFAULTS[key]), String(normalizedFontSize(this.settings[key], kind)));
            a.addAction('保存'); a.addCancelAction('取消');
            if (await a.presentAlert() < 0) return;
            const value = a.textFieldValue(0).trim(), size = Number(value);
            if (!value || !Number.isFinite(size) || size < min || size > max) return alertMessage('未保存', `请输入 ${min}—${max} 之间的数字`);
            this.settings[key] = String(size); this.saveSettings(false);
            if (view && this.insertTextByElementId) this.insertTextByElementId(view, key, String(size));
          } },
      ] }));
      sections.push({ title: '标题文字', menu: [{ name: 'titleFontSize', val: 'titleFontSize', title: '文字大小', type: 'input',
        defaultValue: normalizedTitleSize(this.settings.titleFontSize) == null ? '随尺寸' : String(normalizedTitleSize(this.settings.titleFontSize)),
        desc: '小号、中号共用；8—12，支持小数；留空恢复小号10、中号11', icon: { name: 'textformat.size', color: '#007AFF' },
        onClick: async (_, __, view) => {
          const a = new Alert(); a.title = '标题文字大小'; a.message = '输入 8—12 之间的字号，小号、中号共用；留空恢复默认（小号10、中号11）。长标题自动缩小以适应宽度。';
          a.addTextField('留空恢复默认', normalizedTitleSize(this.settings.titleFontSize) == null ? '' : String(normalizedTitleSize(this.settings.titleFontSize)));
          a.addAction('保存'); a.addCancelAction('取消'); if (await a.presentAlert() < 0) return;
          const value = a.textFieldValue(0).trim(), size = normalizedTitleSize(value);
          if (value && size == null) return alertMessage('未保存', '请输入 8—12 之间的数字，或留空恢复默认');
          if (value) this.settings.titleFontSize = String(size); else delete this.settings.titleFontSize;
          this.saveSettings(false);
          if (view && this.insertTextByElementId) this.insertTextByElementId(view, 'titleFontSize', value ? String(size) : '随尺寸');
        } }] });
      return this.renderAppView(sections);
    }

    async colorSettings() {
      const light = this.settings.theme === '白色';
      const prefix = light ? 'white' : 'black';
      const palette = UF_THEMES[light ? '白色' : '黑色'];
      return this.renderAppView([{ title: `${light ? '白色' : '黑色'}主题颜色`, menu: [
        { title: '组件底色', val: prefix + 'CardColor', type: 'color', defaultValue: '#' + palette.bg, icon: { name: 'square.fill', color: '#555555' } },
        { title: '数字与标题', val: prefix + 'NumberColor', type: 'color', defaultValue: '#' + palette.text, icon: { name: 'textformat', color: '#007AFF' } },
        { title: '主卡颜色', val: prefix + 'FlowBarColor', type: 'color', defaultValue: '#' + palette.blue, icon: { name: 'chart.bar.fill', color: '#0A94FF' } },
        { title: '副卡与用量图', val: prefix + 'ChartBarColor', type: 'color', defaultValue: '#' + palette.purple, icon: { name: 'chart.bar.xaxis', color: '#8A73FF' } },
      ] }]);
    }

    async advancedSettings() {
      const action = (name, title, symbol, color, onClick) => ({ name, title, type: 'input', icon: { name: symbol, color }, onClick });
      return this.renderAppView([{ title: '高级设置', menu: [
        action('flowAccount', '账户说明', 'info.circle', '#FF9500', () => alertMessage('账户说明',
          '使用 QX 现有联通重写保存的 YaYa_10010.cookie，无需手动填写。\n\nCookie 失效时进入联通 App 首页 → 流量查询，再点“立即刷新数据”。')),
        { name: 'flowBoxjsDomain', val: 'flowBoxjsDomain', title: 'BoxJS 域名', desc: '只填域名，不含 http://',
          type: 'input', defaultValue: this.baseSettings.boxjsDomain || 'boxjs.net', placeholder: 'boxjs.net',
          url: 'https://raw.githubusercontent.com/githubdulong/Script/master/Images/boxjs.png' },
        action('flowCategories', '套餐分类', 'list.bullet', '#007AFF', async () => {
          await this.loadResult();
          if (!this.result) return alertMessage('暂无明细', this.failure);
          await chooseCategory(this.store, this.result);
        }),
        { name: 'crossDayLimitMB', val: 'crossDayLimitMB', title: '跨日小流量阈值', type: 'input',
          defaultValue: String(this.settings.crossDayLimitMB == null ? UF_DEFAULTS.crossDayLimitMB : this.settings.crossDayLimitMB),
          desc: '单位 MB；默认10，0关闭；已有待分配区间会按新阈值归入，已归入记录不重算', icon: { name: 'moon.stars', color: '#8A73FF' },
          onClick: async (_, __, view) => {
            const a = new Alert(); a.title = '跨日小流量阈值';
            a.message = '输入0—1024 MB，支持小数，0关闭。仅跨一个午夜且不超过阈值的用量近似归入覆盖时长较长的日期，相同则归后一天。已有待分配区间会按新阈值归入，已归入记录不重算；跨月仍重新建立基线。';
            a.addTextField('10', String(this.settings.crossDayLimitMB == null ? UF_DEFAULTS.crossDayLimitMB : this.settings.crossDayLimitMB));
            a.addAction('保存'); a.addCancelAction('取消'); if (await a.presentAlert() < 0) return;
            const value = a.textFieldValue(0).trim(), limit = Number(value);
            if (!value || !Number.isFinite(limit) || limit < 0 || limit > 1024) return alertMessage('未保存', '请输入0—1024之间的数字');
            this.settings.crossDayLimitMB = String(limit); this.saveSettings(false); this.applySettings();
            if (view && this.insertTextByElementId) await this.insertTextByElementId(view, 'crossDayLimitMB', String(limit));
          } },
        action('flowStatus', '连接检查', 'network', '#007AFF', () => this.connectionStatus()),
        action('flowMemberDiagnostics', '成员字段检查', 'doc.text.magnifyingglass', '#8E8E93', () => this.memberDiagnostics()),
      ] }]);
    }

    registerMenus() {
      const action = (name, title, symbol, color, onClick) => ({ name, title, type: 'input', icon: { name: symbol, color }, onClick });
      this.registerAction({ title: '预览组件', menu: [
        action('flowPreview', '组件预览', 'rectangle.on.rectangle', '#007AFF', () => this.showPreview()),
      ] });
      this.registerAction({ title: '组件配置', menu: [
        action('flowUpdate', '脚本更新', 'arrow.down.circle.fill', '#007AFF', () => this.checkAndUpdateScript()),
        { name: 'theme', val: 'theme', title: '组件主题', type: 'select', options: ['黑色', '白色'], defaultValue: '黑色', icon: { name: 'circle.lefthalf.filled', color: '#555555' } },
        action('flowFonts', '字体与字号', 'textformat', '#007AFF', () => this.fontSettings()),
        action('flowColors', '颜色配置', 'paintpalette.fill', '#AF52DE', () => this.colorSettings()),
        action('flowRefreshSettings', '刷新设置', 'timer', '#34C759', () => this.refreshSettings()),
      ] });
      this.registerAction({ title: '用量与数据', menu: [
        action('flowStatistics', '用量统计', 'chart.bar.xaxis', '#8A73FF', () => this.showUsageStatistics()),
        action('flowRefreshRecords', '刷新记录', 'clock.arrow.circlepath', '#007AFF', () => this.showUsageStatistics(true)),
        action('flowProxy', '立即刷新数据', 'arrow.clockwise', '#34C759', () => this.refreshFromQX()),
      ] });
      this.registerAction({ title: '维护', menu: [
        action('flowReload', '重载组件', 'arrow.triangle.2.circlepath', '#007AFF', () => this.reopenScript()),
        action('flowClear', '数据存储', 'internaldrive', '#007AFF', () => this.clearHistory()),
        action('flowAdvanced', '高级设置', 'gearshape.fill', '#8E8E93', () => this.advancedSettings()),
      ] });
    }
  };
}

async function refreshWithFeedback(instance, medium) {
  const view = new WebView();
  // 先展示触发状态再请求，不把加载文字当作新的成功查询时间。
  await view.loadHTML(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0;padding:32px 22px;background:#${UF.bg};color:#${UF.text};font:16px -apple-system,sans-serif;text-align:center}
    #spin{margin:28px auto;width:22px;height:22px;border:3px solid #8885;border-top-color:#${UF.blue};border-radius:50%;animation:turn .7s linear infinite}
    @keyframes turn{to{transform:rotate(360deg)}}h2{font-size:21px}p{line-height:1.6;color:#${UF.muted}}
    img{display:none;margin:24px auto;width:100%;max-width:${medium ? 600 : 300}px;border-radius:22px}
    </style></head><body><div id="spin"></div><h2 id="status">正在刷新…</h2><p id="detail">已收到点击，正在查询联通用量</p><img id="preview" alt="刷新后的组件"></body></html>`);
  const closed = view.present().catch(() => {});
  try {
    instance.widgetFamily = medium ? 'medium' : 'small';
    await instance.loadResult(true, 'manual');
    if (instance.result && !instance.result.stale) instance.result.manualRefresh = true;
    const widget = instance.result ? makeWidget(instance.result, medium, instance.flowMode) : errorWidget(instance.failure, medium);
    Script.setWidget(widget);
    const success = instance.result && !instance.result.stale;
    const message = success ? '查询完成；桌面组件的重绘时间由 iOS 调度。'
      : instance.result ? '查询未成功，继续显示上次缓存，更新时间保持不变。' : '查询未成功，请从配置菜单检查连接和 Cookie。';
    const preview = widget.backgroundImage ? 'data:image/png;base64,' + Data.fromPNG(widget.backgroundImage).toBase64String() : '';
    await view.evaluateJavaScript(`document.getElementById('spin').style.display='none';
      document.getElementById('status').textContent=${JSON.stringify(success ? '刷新成功' : '刷新失败')};
      document.getElementById('detail').textContent=${JSON.stringify(message)};
      document.getElementById('preview').src=${JSON.stringify(preview)};
      document.getElementById('preview').style.display=${JSON.stringify(preview ? 'block' : 'none')};`);
  } catch (_) {
    // 用户提前关闭反馈页也不影响已经完成的数据保存。
    try { await view.evaluateJavaScript("document.getElementById('spin').style.display='none';document.getElementById('status').textContent='刷新未完成';document.getElementById('detail').textContent='请重新点击组件重试';"); } catch (_) {}
  }
  await closed;
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
  // 自行发布组件，防止 DmYY.Runing 把共享截止时间覆盖为“现在＋间隔”。
  if (config.runsInWidget) {
    const instance = new Widget(args.widgetParameter || '');
    Script.setWidget(await instance.render()); Script.complete(); return;
  }
  // 卡片点击走独立查询入口，避免 DmYY 仅打开配置菜单而不查数据。
  if (config.runsInApp && args.queryParameters && args.queryParameters.ufRefresh === '1') {
    const instance = new Widget(args.queryParameters.ufMode || args.widgetParameter || '');
    const medium = args.queryParameters.ufFamily === 'medium';
    await refreshWithFeedback(instance, medium);
    Script.complete(); return;
  }
  await dependency.Runing(Widget, args.widgetParameter || '', false);
}

// 便于在桌面验证纯数据逻辑；Scriptable 不定义该变量。
if (typeof UNICOM_FLOW_TEST === 'undefined') await main();
