const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scriptable/UnicomFlow.js'), 'utf8');
const load = new vm.Script('(async () => {' + source + '\nreturn {monthlyReport, monthlyHTML, parsePackages, megabytes, formatMB, updateHistory, todayBuckets, sessionTag, memberStructure, renderImage, applyTheme, displayMetrics, sharedComposition, createWidgetClass, validateUpdateSource, installUpdate, main};})()');

function fixture() {
  return { code: '0000', resources: [{ type: 'flow', details: [
    { feePolicyId: 'normal', feePolicyName: '国内通用流量', total: '27648', use: '2355.2', remain: '25292.8', limited: '0' },
    { feePolicyId: 'video', feePolicyName: '视频定向流量', addupItemCode: '40008', total: '102400', use: '38604.8', remain: '63795.2', limited: '0' },
  ] }, { type: 'voice', details: [{ feePolicyId: 'voice', total: '100', use: '20' }] }] };
}

function distributionFixture() {
  return { code:'0000', resources:[{type:'flow',details:[
    {feePolicyId:'main',feePolicyName:'5G畅爽冰激凌199元（首月全量全价）（上月结转限本月使用）',total:120*1024,use:3.22*1024,remain:116.78*1024,limited:'0'},
  ]}],unshared:[{type:'unsharedFlowList',details:[
    {feePolicyId:'gift',feePolicyName:'政企0元80GB国内通用流量包24期（江苏）',total:80*1024,use:8.81*1024,remain:71.19*1024,limited:'0'},
  ]}]};
}

(async () => {
  const api = await load.runInNewContext({ UNICOM_FLOW_TEST: true });
  const { parsePackages, megabytes, formatMB, updateHistory, todayBuckets } = api;
  const base = parsePackages(fixture());
  const cardFixture=distributionFixture();
  cardFixture.viceCardLits=[{number:'13000000001',role:'main'}, {number:'13000000002',role:'vice'}];
  cardFixture.resources[0].details[0].viceCardlist=[{number:'13000000001',use:1.22*1024},{number:'13000000002',use:2*1024,currentLoginFlag:'1'}];
  const cards=parsePackages(cardFixture);
  const splitCards=api.displayMetrics(cards,'主副卡分开显示');
  assert.equal(splitCards.leftLabel,'主卡·0001'); assert.equal(splitCards.rightLabel,'副卡·0002');
  assert.equal(splitCards.left.used,(1.22+8.81)*1024); assert.equal(splitCards.right.used,2*1024);
  assert.equal(splitCards.left.total,null); assert.ok(splitCards.left.detail.includes('独享'));
  const c=api.displayMetrics(cards).left.composition;
  assert.equal(c.complete,true);assert.equal(c.main,1.22*1024);assert.equal(c.vice,2*1024);
  assert.equal(api.displayMetrics(cards,'统一显示').leftLabel,'主卡+副卡');
  const compositionRows = [{id:'a',role:'主卡',used:0},{id:'b',role:'副卡',used:12}];
  const composition = (members, used=12) => api.sharedComposition([{used,members}]);
  assert.equal(composition(compositionRows).complete,true); // 主卡为零，整条紫色
  assert.equal(composition(compositionRows.slice(1)).complete,false); // 不用减法补主卡
  assert.equal(composition(compositionRows,13).complete,false); // 不一致时不分色
  assert.equal(composition(compositionRows.map(row=>({...row,used:0})),0).complete,true);
  assert.equal(composition([...compositionRows,compositionRows[1]]).vice,12); // 同成员去重
  assert.equal(composition([...compositionRows,{...compositionRows[1],used:13}]).vice,null);

  const variant=distributionFixture();variant.viceCardList=[{number:'13000000001',role:'main'}];
  variant.shareData={details:[{feePolicyId:'main',feePolicyName:'5G畅爽冰激凌199元（首月全量全价）（上月结转限本月使用）',elemType:'3',viceCardList:[{number:'13000000001',use:20}]}]};
  const variantData=parsePackages(variant);assert.equal(variantData.members[0].records[0].used,20);
  assert.equal(variantData.categories.general.total,200*1024); // shareData 只补成员，不重复统计额度
  const report=api.memberStructure({...variant,cookie:'SECRET_COOKIE',phone:'13000000001'});
  assert.ok(report.includes('shareData.details[0].viceCardList'));
  assert.ok(!report.includes('SECRET_COOKIE'));assert.ok(!report.includes('13000000001'));

  assert.equal(api.displayMetrics(base,'主副卡分开显示').left,null);

  assert.equal(cards.members.length,2); assert.equal(cards.members[0].role,'主卡'); assert.equal(cards.members[1].role,'副卡');
  assert.equal(cards.members[1].current,true); assert.equal(cards.members[1].records[0].used,2048);
  assert.equal(cards.members[0].records.length,1); // 原始成员明细仍只记录共享部分；展示时另加用户确认的主卡独享包
  assert.equal(cards.packages[0].used,3.22*1024); // 共享总量保持不变
  assert.equal(cards.members[0].phone,'130****0001');
  assert.ok(!JSON.stringify(cards).includes('13000000001'));
  const currentOnly=distributionFixture();
  currentOnly.resources[0].details[0].viceCardlist=[{number:'13000000002',use:0,currentLoginFlag:'1'}];
  const currentCard=parsePackages(currentOnly).members[0];
  assert.equal(currentCard.role,'成员卡'); assert.equal(currentCard.records[0].used,0); // 当前登录不等于主卡
  currentOnly.resources[0].details[0].viceCardlist.push({number:'13000000002',use:4});
  const conflict=parsePackages(currentOnly).members[0];assert.equal(conflict.records[0].used,null);assert.equal(conflict.records[0].conflict,true);
  const absent=distributionFixture();absent.viceCardLits=[{number:'13000000003'}];
  assert.equal(parsePackages(absent).members[0].records.length,0);
  assert.equal(parsePackages(fixture()).members.length,0);
  // 未知数字标记不猜测主副卡角色。
  const unknownRole=distributionFixture(); unknownRole.viceCardLits=[{number:'13000000007',numberFlag:'2',viceCardflag:'9'}];
  assert.equal(parsePackages(unknownRole).members[0].role,'成员卡');
  // 字段名未知的成员数组按“号码 + 用量”结构识别，号码字段与字符串单位都要能解析。
  const generic=distributionFixture();
  generic.subCards=[{viceCardNo:'13000000009',role:'vice',usedFlow:'1.5GB'}];
  const genericData=parsePackages(generic);
  assert.equal(genericData.members.length,1);
  assert.equal(genericData.members[0].role,'副卡');
  assert.equal(genericData.members[0].records[0].used,1.5*1024);
  assert.equal(genericData.categories.general.total,200*1024); // 未知成员明细不并入套餐池
  const genericReport=api.memberStructure(generic);
  assert.ok(genericReport.includes('subCards: 1 条含号码与用量'));
  assert.ok(genericReport.includes('subCards[]: viceCardNo, role, usedFlow'));
  assert.ok(!genericReport.includes('13000000009')); assert.ok(!genericReport.includes('1.5GB'));
  // shareData 明细不再依赖 elemType，能对上套餐就补成员。
  const noElem=distributionFixture();
  noElem.shareData={details:[{feePolicyId:'main',viceCardList:[{number:'13000000005',use:7}]}]};
  assert.equal(parsePackages(noElem).members[0].records[0].used,7);
  const others=distributionFixture();others.shareData={details:[{feePolicyId:'unknown',viceCardList:[{number:'13000000006',use:3}]}]};
  const unmatched=parsePackages(others); // 对不上套餐时仍按成员明细展示，不猜测套餐归属
  assert.equal(unmatched.members.length,1);
  assert.equal(unmatched.members[0].records[0].used,3);
  assert.match(unmatched.members[0].records[0].name,/成员明细/);
  // 真实抓包结构（2026-11-03，号码已替换）：逐卡用量在 details.viceCardlist，shareData 镜像同一份，
  // 顶层 viceCardLits 只有号码与 numberFlag；镜像数组不能重复累加。
  const captured=distributionFixture();
  const cardRows=[{usernumber:'186****0001',use:'0.0',viceCardflag:'1',currentLoginFlag:'1'},
    {usernumber:'186****0002',use:'3859.66',viceCardflag:'0',currentLoginFlag:'0'}];
  captured.viceCardLits=[{number:'186****0001',numberFlag:'0'},{number:'186****0002',numberFlag:'1'}];
  captured.resources[0].details[0].viceCardlist=cardRows;
  captured.shareData={mobile:'186****0001',details:[{...captured.resources[0].details[0],viceCardlist:cardRows}],viceCardList:cardRows};
  // 含号码和 use 的语音、短信成员数组不能被兜底解析当成 MB。
  const mixedUnits=JSON.parse(JSON.stringify(captured));
  mixedUnits.resources.push({type:'Voice',details:[{elemType:'1',viceCardlist:[
    {usernumber:'186****0002',use:'13',viceCardflag:'0'},
  ]}]}, {type:'smsList',details:[{elemType:'2',viceCardlist:[
    {usernumber:'186****0002',use:'7',viceCardflag:'0'},
  ]}]});
  const flowOnly=parsePackages(mixedUnits).members.find(m=>m.role==='副卡');
  assert.equal(flowOnly.records.length,1);
  assert.equal(flowOnly.records[0].used,Number(cardRows[1].use));
  const capturedData=parsePackages(captured);
  assert.equal(capturedData.members.length,2);
  assert.equal(capturedData.members[0].role,'主卡'); assert.equal(capturedData.members[1].role,'副卡');
  assert.equal(capturedData.members[0].records.length,1); assert.equal(capturedData.members[0].records[0].used,0);
  assert.equal(capturedData.members[1].records.length,1); assert.equal(capturedData.members[1].records[0].used,3859.66);
  assert.equal(capturedData.categories.general.total,200*1024); // 成员明细不改写套餐池额度
  const capturedSplit=api.displayMetrics(capturedData,'主副卡分开显示');
  assert.equal(capturedSplit.leftLabel,'主卡·0001'); assert.equal(capturedSplit.rightLabel,'副卡·0002');
  assert.equal(capturedSplit.left.used,8.81*1024); assert.equal(capturedSplit.right.used,3859.66);
  assert.equal(capturedSplit.left.total,null); assert.ok(capturedSplit.left.detail.includes('独享'));

  const distribution=parsePackages(distributionFixture());
  assert.equal(distribution.categories.directed,null); // 两项均为通用，不冒充定向
  assert.equal(distribution.categories.general.total,200*1024);
  assert.ok(Math.abs(distribution.categories.general.used/1024-12.03)<1e-9);
  const split=api.displayMetrics(distribution);
  assert.equal(split.leftLabel,'主卡+副卡'); assert.equal(split.rightLabel,'主卡独享');
  assert.equal(split.left.total,120*1024); assert.equal(split.right.total,80*1024);
  assert.equal(formatMB(split.left.used),'3.22GB'); assert.equal(formatMB(split.right.used),'8.81GB');
  const insideResources=distributionFixture(); insideResources.resources[0].details.push(insideResources.unshared[0].details[0]);delete insideResources.unshared;
  assert.equal(api.displayMetrics(parsePackages(insideResources)).right.total,80*1024); // 赠送包名称识别
  const forced=parsePackages(fixture(),{[base.packages[0].id]:'shared',[base.packages[1].id]:'exclusive'});
  assert.equal(api.displayMetrics(forced).rightLabel,'主卡独享');
  assert.equal(api.displayMetrics(base).leftLabel,'通用'); // 无可靠共享信息时不猜测
  const extra=distributionFixture();extra.mlresources=[{type:'flow',details:[{feePolicyId:'other',feePolicyName:'定向',total:1,use:0.01,remain:0.99}]}];
  assert.equal(api.displayMetrics(parsePackages(extra)).omitted,true);

  assert.equal(base.packages.length, 2);
  assert.equal(base.categories.general.used, 2355.2);
  assert.equal(base.categories.directed.used, 38604.8);
  assert.equal(formatMB(base.categories.general.used), '2.3GB');
  assert.equal(formatMB(null), '--');
  assert.equal(megabytes('1,024 MB'), 1024);
  assert.equal(megabytes('2', 'GB'), 2048);
  assert.equal(megabytes('not-a-number'), null);
  assert.equal(megabytes('-1'), null);
  assert.equal(megabytes('', 'MB'), null);
  assert.equal(megabytes('2', 'unknown'), null);
  assert.throws(() => parsePackages({ code: '999999' }), /Cookie/);
  assert.throws(() => parsePackages({ code: '0000', resources: [] }), /未识别/);
  const missing = fixture(); missing.resources[0].details.pop();
  assert.equal(parsePackages(missing).categories.directed, null);
  const malformed = fixture(); malformed.resources[0].details[0].use = 'unknown'; malformed.resources[0].details[0].total = '';
  assert.equal(parsePackages(malformed).categories.general, null);
  assert.ok(parsePackages(malformed).warnings.length);
  const duplicate = fixture(); duplicate.unshared = JSON.parse(JSON.stringify(duplicate.resources));
  assert.equal(parsePackages(duplicate).packages.length, 2);
  duplicate.unshared[0].details[0].use = '3000';
  assert.throws(() => parsePackages(duplicate), /同一套餐/);
  const unlimited = fixture(); unlimited.resources[0].details[1].limited = '1';
  assert.equal(parsePackages(unlimited).categories.directed.total, null);
  const override = { [base.packages[0].id]: 'directed', [base.packages[1].id]: 'ignore' };
  assert.equal(parsePackages(fixture(), override).categories.directed.used, 2355.2);
  assert.equal(parsePackages(fixture(), override).categories.general, null);
  const at = new Date(2026, 10, 3, 10, 0).getTime();
  const sample = (time, increment = 0, totalChange = 0) => ({ ...base, session: 'test-session', at: time,
    packages: base.packages.map((p, i) => ({ ...p, used: p.used + increment, total: p.total + (i ? 0 : totalChange) })) });
  let h = updateHistory(null, sample(at));
  assert.equal(h.events.length, 0);
  h = updateHistory(h, sample(at + 3600000, 5));
  assert.equal(h.events[0].mb, 10);
  assert.equal(todayBuckets(h, at)[11].mb, 10);
  assert.equal(todayBuckets(h, at)[10].samples, 0); // 没有伪造早前时段
  assert.equal(updateHistory(h, sample(at + 7200000, 1)).events.length, 0); // 回退
  assert.equal(updateHistory(h, sample(at + 7200000, 8, 1024)).events.length, 0); // 套餐变化
  assert.equal(updateHistory(h, { ...sample(at + 7200000, 8), session: 'other' }).events.length, 0);
  assert.equal(updateHistory(h, sample(at - 1000, 1)).last.at, h.last.at); // 乱序查询
  const midnight = new Date(2026, 10, 4, 0, 5).getTime();
  assert.equal(updateHistory(h, sample(midnight, 20)).events.length, 1); // 跨午夜不新增
  assert.equal(todayBuckets(updateHistory(h, sample(midnight, 20)), midnight).reduce((n,b) => n+b.samples, 0), 0);
  const nextMonth = new Date(2026, 11, 1, 1).getTime();
  assert.equal(updateHistory(h, sample(nextMonth, 20)).events.length, 0);

  // 日聚合与小时图相互独立：未知日期不补零，真实零增量仍有记录。
  const firstMonthly=api.monthlyReport(updateHistory(null,sample(at)),at);
  assert.equal(firstMonthly.days[2].mb,null);
  assert.equal(firstMonthly.days[1].mb,null);
  assert.equal(firstMonthly.days[3].future,true);
  assert.equal(firstMonthly.totalMB,null);
  let monthHistory=updateHistory(null,sample(at));
  monthHistory=updateHistory(monthHistory,sample(at+3600000,5));
  let monthReport=api.monthlyReport(monthHistory,at+3600000);
  assert.equal(monthReport.totalMB,10);assert.equal(monthReport.days[2].intervals,1);
  const originalMonthly=JSON.stringify(monthHistory.months);
  const equalTime=updateHistory(monthHistory,sample(at+3600000,100));
  assert.equal(JSON.stringify(equalTime.months),originalMonthly);
  const cross=updateHistory(monthHistory,sample(midnight,20));
  monthReport=api.monthlyReport(cross,midnight);
  assert.equal(monthReport.totalMB,10);assert.equal(monthReport.days[3].mb,null);
  assert.equal(monthReport.unallocatedMB,30);assert.equal(monthReport.crossDay.length,1);
  assert.ok(monthReport.days[2].notes.includes('跨日区间未分配'));
  assert.ok(monthReport.days[3].notes.includes('跨日区间未分配'));
  const zero=updateHistory(cross,sample(midnight+3600000,20));
  assert.equal(api.monthlyReport(zero,midnight).days[3].mb,0);
  const rollback=updateHistory(zero,sample(midnight+7200000,1));
  monthReport=api.monthlyReport(rollback,midnight);
  assert.equal(monthReport.totalMB,10);assert.ok(monthReport.days[3].notes.some(n=>n.includes('回退')));
  const changed=updateHistory(zero,sample(midnight+7200000,22,1024));
  assert.equal(api.monthlyReport(changed,midnight).totalMB,10);
  const legacy={...monthHistory};delete legacy.months;
  const imported=updateHistory(legacy,sample(at+7200000,7));
  assert.equal(api.monthlyReport(imported,at).totalMB,14);
  assert.equal(api.monthlyReport(updateHistory(imported,sample(at+10800000,8)),at).totalMB,16);
  const separated=updateHistory(monthHistory,{...sample(at+7200000,7),session:'new-user'});
  assert.equal(api.monthlyReport(separated,at).totalMB,null);
  const afterSevenDays=updateHistory(monthHistory,sample(at+10*86400000,100));
  assert.equal(afterSevenDays.events.length,0);assert.equal(api.monthlyReport(afterSevenDays,at+10*86400000).totalMB,10);
  const december=updateHistory(monthHistory,sample(nextMonth,0));
  assert.ok(december.months['2026-11']);assert.ok(december.months['2026-12']);
  assert.equal(api.monthlyReport(december,nextMonth).totalMB,null);
  const january=new Date(2027,0,1,12).getTime();
  const januaryHistory=updateHistory(december,sample(january,0));
  assert.equal(januaryHistory.months['2026-11'],undefined);assert.ok(januaryHistory.months['2026-12']);
  assert.equal(api.monthlyReport(januaryHistory,january).days.length,31);
  const leap=new Date(2028,1,2,12).getTime();
  assert.equal(api.monthlyReport(updateHistory(null,sample(leap)),leap).days.length,29);
  // 旧版缓存可离线显示过去保留的同日记录。
  assert.equal(api.monthlyReport(legacy,at).totalMB,10);

  // 执行月度页实际脚本，确认日期点击、零值、缺失值和明细渲染。
  class Element {
    constructor(){this.children=[];this.dataset={};this.style={};this.classList={toggle:()=>{}};}
    append(...items){this.children.push(...items);}setAttribute(){}
  }
  const elements=new Map();const doc={getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:()=>new Element(),querySelectorAll:()=>elements.get('chart').children};
  const html=api.monthlyHTML(api.monthlyReport(zero,midnight),true);
  const pageCode=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(pageCode).runInNewContext({document:doc});
  assert.equal(elements.get('chart').children.length,30);assert.equal(elements.get('rows').children.length,30);
  const monthBars=elements.get('chart').children;
  assert.equal(monthBars[0].children[0].style.height,'4px');assert.ok(monthBars[0].children[0].className.includes('missing'));
  assert.equal(monthBars[3].children[0].style.height,'4px');assert.equal(monthBars[3].children[0].className,'fill');
  assert.equal(monthBars[4].children[0].style.height,'0px');assert.ok(monthBars[4].children[0].className.includes('future'));

  assert.equal(elements.get('selected').textContent,'2026-11-04');
  assert.ok(elements.get('detail').textContent.includes('0.00 MB'));
  elements.get('chart').children[1].onclick();
  assert.equal(elements.get('selected').textContent,'2026-11-02');assert.ok(elements.get('detail').textContent.includes('—'));
  elements.get('rows').children[2].children[0].children[0].onclick();
  assert.equal(elements.get('selected').textContent,'2026-11-03');
  const malicious=api.monthlyHTML({...monthReport,today:'</script><img src=x>'});
  assert.equal((malicious.match(/<\/script>/g)||[]).length,1);
  assert.ok(!html.includes('13000000001'));
  api.applyTheme({theme:'白色'});assert.ok(api.monthlyHTML(monthReport).includes('color-scheme:light'));
  api.applyTheme({theme:'黑色'});

  const monthlyOutput='/private/tmp/unicom-monthly-preview';fs.mkdirSync(monthlyOutput,{recursive:true});fs.writeFileSync(monthlyOutput+'/monthly.html',html);

  // 真正的原生绘图代码在 mock 中执行，将相同绘图指令输出为 SVG 供视觉检查。
  const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  class Color { constructor(hex) { this.hex = '#' + hex; } static white() { return new Color('FFFFFF'); } }
  class Rect { constructor(x,y,width,height) { Object.assign(this,{x,y,width,height}); } }
  class Size { constructor(width,height) { Object.assign(this,{width,height}); } }
  class Path { addRoundedRect(rect, rx, ry) { this.rect = rect; this.rx = rx; this.ry = ry; } }
  class DrawContext {
    constructor() { this.parts=[]; }
    setFillColor(c) { this.fill=c.hex; } setTextColor(c) { this.text=c.hex; }
    setFont(f) { this.font=f; } setTextAlignedLeft() {this.centered=false;} setTextAlignedCenter() {this.centered=true;}
    fillRect(r) { this.parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${this.fill}"/>`); }
    addPath(p) { this.path=p; }
    fillPath() { const r=this.path.rect; this.parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${this.path.rx}" ry="${this.path.ry}" fill="${this.fill}"/>`); }
    drawTextInRect(t,r) { this.parts.push(`<text x="${this.centered?r.x+r.width/2:r.x}" y="${r.y+this.font.size}" text-anchor="${this.centered?'middle':'start'}" fill="${this.text}" font-family="${this.font.name || (this.font.mono?'Menlo,monospace':'sans-serif')}" font-weight="${this.font.weight||400}" font-size="${this.font.size}">${esc(t)}</text>`); }
    getImage() { assert.ok(this.parts.length); return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.size.width*3}" height="${this.size.height*3}" viewBox="0 0 ${this.size.width} ${this.size.height}"><defs><clipPath id="card"><rect width="100%" height="100%" rx="20"/></clipPath></defs><g clip-path="url(#card)">${this.parts.join('')}</g></svg>`; }
  }
  let unavailableFont=false;
  class Font { constructor(name,size) { if(unavailableFont) throw new Error('missing font'); Object.assign(this,{name,size}); } }
  Object.assign(Font, { regularMonospacedSystemFont: size => ({size,mono:true}), mediumMonospacedSystemFont:size=>({size,mono:true,weight:500}), mediumSystemFont:size=>({size,weight:500}), systemFont:size=>({size}), lightSystemFont:size=>({size,weight:300}), regularSystemFont:size=>({size,weight:400}) });
  const visual = await load.runInNewContext({ UNICOM_FLOW_TEST: true, Color, Rect, Size, Path, DrawContext, Font });
  const output = '/private/tmp/unicom-flow-preview'; fs.mkdirSync(output,{recursive:true});
  const visualAt = Date.now();
  const previewFixture=distributionFixture();
  previewFixture.resources[0].details[0].viceCardlist=[{number:'13000000001',role:'main',use:1.2*1024},{number:'13000000002',role:'vice',use:2.02*1024}];
  const previewData=parsePackages(previewFixture);
  const history = updateHistory(null, { ...previewData, at: visualAt, session:'preview' });
  history.events = [8,12,16,17,18,19,20].filter(hour => hour <= new Date().getHours()).map((hour,i)=>({
    from:new Date(new Date().setHours(hour,0,0,0)).getTime(), at:new Date(new Date().setHours(hour,30,0,0)).getTime(), mb:[30,85,40,260,240,280,150][i] }));
  for (const [name,medium,width,height] of [['small',false,158,158],['medium',true,338,158]]) {
    fs.writeFileSync(`${output}/${name}.svg`,visual.renderImage({history,stale:false},medium,width,height));
    fs.writeFileSync(`${output}/${name}-empty.svg`,visual.renderImage({history:{...history,events:[],data:{...base,categories:{general:base.categories.general,directed:null},at:visualAt}},stale:true},medium,width,height));
  }

  // 所有小时标签、竖线和柱子共用同一格的中心点，不再为 23 点单独偏移。
  const aligned=visual.renderImage({history,stale:false},true,338,158);
  assert.ok(aligned.includes('主 1.2GB')); assert.ok(aligned.includes('副 2.02GB'));
  const sharedSegments=[...aligned.matchAll(/<rect x="13" y="([0-9.]+)" width="5" height="([0-9.]+)" rx="2.5" ry="[0-9.]+" fill="#(?:0A94FF|8A73FF)"/g)];
  assert.equal(sharedSegments.length,2);
  assert.ok(Math.abs(Number(sharedSegments[0][2])-37*1.2/120)<1e-8);
  assert.ok(Math.abs(Number(sharedSegments[1][2])-37*2.02/120)<1e-8);
  assert.ok(Math.abs(Number(sharedSegments[0][1])+Number(sharedSegments[0][2])-71)<1e-8);
  assert.ok(Math.abs(Number(sharedSegments[1][1])+Number(sharedSegments[1][2])-Number(sharedSegments[0][1]))<1e-8);
  // 超额不超出轨道；零用量、不限量以及不完整的成员数据不绘制虚假进度。
  for (const [used,total,main,vice,colored] of [[150,120,50,100,true],[0,120,0,0,false],[12,null,4,8,false],[12,120,4,7,false]]) {
    const edgeData={...previewData,packages:previewData.packages.map(p=>p.shared?{...p,used,total,members:[{id:'a',role:'主卡',used:main},{id:'b',role:'副卡',used:vice}]}:p),members:[]};
    const edgeSvg=visual.renderImage({history:{...history,data:edgeData},stale:false},true,338,158);
    const bars=[...edgeSvg.matchAll(/<rect x="13" y="([0-9.]+)" width="5" height="([0-9.]+)" rx="2.5" ry="[0-9.]+" fill="#(?:0A94FF|8A73FF)"/g)];
    assert.equal(bars.length,colored?2:0);
    for(const bar of bars) { assert.ok(Number(bar[1])>=34-1e-8); assert.ok(Number(bar[1])+Number(bar[2])<=71+1e-8); }
  }

  const viceOnlyData={...previewData,packages:previewData.packages.map(p=>p.shared?{...p,members:[{id:'a',role:'主卡',used:0},{id:'b',role:'副卡',used:p.used}]}:p),members:[]};
  const viceOnly=visual.renderImage({history:{...history,data:viceOnlyData},stale:false},true,338,158);
  assert.ok(/x="13" y="[0-9.]+" width="5" height="[0-9.]+" rx="2.5" ry="[0-9.]+" fill="#8A73FF"/.test(viceOnly));
  const step=(338-26)/24;
  for(const hour of [0,6,12,18,23]) {
    const expected=13+(hour+0.5)*step;
    const tick=aligned.match(new RegExp('<text x="([0-9.]+)"[^>]*text-anchor="middle"[^>]*>'+String(hour).padStart(2,'0')+'</text>'));
    assert.ok(tick); assert.ok(Math.abs(Number(tick[1])-expected)<1e-8);
    assert.ok(aligned.includes(`x="${expected-0.25}" y="105"`));
  }

  // 过去小时灰色占位、真实零增量为紫色；当前无采样及未来小时不画柱。
  const fixedNoon=new Date(2026,10,4,12,30).getTime();
  class NoonDate extends Date {static now(){return fixedNoon;}}
  const noonVisual=await load.runInNewContext({UNICOM_FLOW_TEST:true,Date:NoonDate,Color,Rect,Size,Path,DrawContext,Font});
  const emptyHours={...history,data:{...history.data,at:fixedNoon},events:[]};
  const dayImage=noonVisual.renderImage({history:emptyHours,stale:false},true,338,158);
  const hourlyBar=hour=>`x="${13+(hour+0.5)*13-5}" y="126.5" width="10" height="1.5"`;
  for(let hour=0;hour<12;hour++) assert.ok(dayImage.includes(hourlyBar(hour)+' fill="#454548"'));
  for(let hour=12;hour<24;hour++) assert.ok(!dayImage.includes(hourlyBar(hour)));
  const zeroHours={...emptyHours,events:[{from:new Date(2026,10,4,9,0).getTime(),at:new Date(2026,10,4,9,30).getTime(),mb:0}]};
  const zeroImage=noonVisual.renderImage({history:zeroHours,stale:false},true,338,158);
  assert.ok(zeroImage.includes(hourlyBar(9)+' fill="#8A73FF"'));

  // 小号在不同手机尺寸下使用相同的安全留白，始终显示查询时间与刷新入口。
  for (const side of [141,158,170]) {
    const image=visual.renderImage({history,stale:false},false,side,side);
    assert.ok(!image.includes('点击刷新')); assert.ok(/更新 \d{2}:\d{2}:\d{2}/.test(image));
    const textPositions=[...image.matchAll(/<text x="([0-9.]+)" y="([0-9.]+)"/g)];
    assert.ok(textPositions.length>=6);
    assert.ok(textPositions.every(m=>Number(m[1])>=13&&Number(m[2])>=12&&Number(m[2])<=150));
  }

  for(const theme of ['黑色','白色']) {
    visual.applyTheme({theme});
    for (const [name,medium,width,height] of [['small',false,158,158],['medium',true,338,158]]) {
      const svg=visual.renderImage({history,stale:false},medium,width,height);
      assert.ok(svg.includes(theme==='白色'?'#FFFFFF':'#1C1C1E'));
      assert.ok(svg.includes(theme==='白色'?'#1C1C1E':'#F5F5F7'));
      fs.writeFileSync(`${output}/${name}-${theme==='白色'?'light':'dark'}.svg`,svg);
    }
  }

  // 首次未配置、缓存降级及小组件启动分支均可完成，且只请求指定的 Cookie 字段。
  const files=new Map(); let requestCount=0, widget=null, completed=0, apiError=false, lastRequest=null;
  let updateSource=source, cloudFile=false, cloudDownloads=0, failScriptWrite=false, dataPayload=fixture(), rawResponse=null, formBroken=false;
  const alertChoices=[], alerts=[];
  class FileManager {
    static local(){return new FileManager();} static iCloud(){return new FileManager();}
    isFileStoredIniCloud(){return cloudFile;} async downloadFileFromiCloud(){cloudDownloads++;} documentsDirectory(){return '/documents';} joinPath(a,b){return a+'/'+b;}
    fileExists(p){return p.endsWith('/UnicomFlow')||files.has(p);} createDirectory(){} readString(p){return files.get(p);}
    writeString(p,v){if(failScriptWrite && p==='/documents/联通流量.js'){failScriptWrite=false;files.set(p,'partial');throw new Error('write failed');} files.set(p,v);} remove(p){files.delete(p);}
  }
  class Request {
    constructor(url){this.url=url;}
    async loadString(){ if(this.url.startsWith('https://raw.githubusercontent.com/42vio/quantumultx-scripts/main/scriptable/UnicomFlow.js?')){if(updateSource instanceof Error)throw updateSource;return updateSource;}
      requestCount++; lastRequest={url:this.url,method:this.method,headers:this.headers,body:this.body};
      if(apiError)throw new Error('offline');
      if(formBroken && this.body) return JSON.stringify({code:'9999'});
      return rawResponse===null?JSON.stringify(dataPayload):rawResponse;}
    async loadJSON(){requestCount++; if(this.url.includes('/query/data/')) return {val:'JSESSIONID=FAKE_TEST_ONLY;'};
      lastRequest={url:this.url,method:this.method,headers:this.headers,body:this.body};
      if(apiError)throw new Error('offline'); return dataPayload;}
  }
  const presented=[], feedback=[];
  class WebView {
    async loadHTML(html){this.entry={html,updates:[],requestsAtOpen:requestCount};feedback.push(this.entry);}
    async present(){this.entry.presented=true;}
    async evaluateJavaScript(js){this.entry.updates.push(js);}
  }
  class Stack {
    constructor(){this.children=[];}
    addStack(){const child=new Stack();this.children.push(child);return child;}
    layoutHorizontally(){} layoutVertically(){} setPadding(){} addSpacer(){}
  }

  class ListWidget extends Stack {
    async presentSmall(){presented.push('small');} async presentMedium(){presented.push('medium');}
    setPadding(){} addImage(){return {};} addText(value){(this.texts=this.texts||[]).push(String(value));return {};} addSpacer(){}
  }
  class Alert {
    addAction(){} addCancelAction(){}
    async presentSheet(){return this.presentAlert();}
    async presentAlert(){alerts.push({title:this.title,message:this.message});return alertChoices.length?alertChoices.shift():0;}
  }
  class MockDmYY {
    constructor() { this.settings={}; this.baseSettings={}; this.widgetFamily='medium'; this._menuActions=[]; }
    registerAction(item){this._menuActions.push(item);}
    saveSettings(){} reopenScript(){}
    async renderAppView(options, avatar){return {options,avatar};}
  }
  const dependency = { DmYY:MockDmYY, Runing:async Widget=>{
    const instance = new Widget('');
    environment.Script.setWidget(await instance.render()); environment.Script.complete();
  }};
  const environment = { UNICOM_FLOW_TEST:true, config:{runsInWidget:true,runsInApp:false,widgetFamily:'medium'},
    args:{widgetParameter:'',queryParameters:{}}, importModule:name=>{assert.equal(name,'DmYY');return dependency;},
    FileManager, Request, ListWidget, Color, Rect, Size, Path, DrawContext, Alert, WebView, Data:{fromPNG:()=>({toBase64String:()=> 'FAKE_PREVIEW'})}, module:{filename:'/documents/联通流量.js'},
    Font:Object.assign(class extends Font {},Font,{boldSystemFont:size=>({size})}), Device:{screenSize:()=>({width:390,height:844})},
    Script:{name:()=> '联通流量',setWidget:w=>{widget=w;},complete:()=>{completed++;}} };
  const integration = await load.runInNewContext(environment);
  await integration.main(); assert.equal(requestCount,2); assert.equal(completed,1); assert.ok(widget.backgroundImage);
  // 与成功抓包相同的接口主机与表单体。
  assert.equal(new URL(lastRequest.url).host,'mxx.client.10010.com');
  assert.equal(lastRequest.method,'POST');
  assert.match(lastRequest.headers['Content-Type'],/application\/x-www-form-urlencoded/);
  assert.equal(lastRequest.body,'language=chinese');
  assert.match(lastRequest.headers.Cookie,/JSESSIONID=FAKE_TEST_ONLY/);
  apiError=true; await integration.main(); assert.equal(completed,2); assert.ok(widget);
  files.clear(); await integration.main(); assert.equal(completed,3); assert.ok(widget);
  // 过期 Cookie 时联通返回纯文本 999999，需要给出可操作的提示而不是“接口不可用”。
  apiError=false; rawResponse='999999'; files.delete('/documents/UnicomFlow/history.json');
  await integration.main(); assert.equal(completed,4); assert.match(widget.texts.join('|'),/Cookie 可能已失效/);
  rawResponse=null; files.clear();
  // 表单请求失败时退回不带表单的旧请求，套餐池照常显示。
  formBroken=true; files.delete('/documents/UnicomFlow/history.json'); const beforeFallback=requestCount;
  await integration.main(); assert.equal(completed,5); assert.equal(requestCount,beforeFallback+3); // Cookie + 两次数据请求 assert.ok(widget.backgroundImage);
  formBroken=false; files.clear();
  assert.ok(!Array.from(files.values()).join('').includes('FAKE_TEST_ONLY'));
  // App 打开配置页不查账号；DnYY 分组菜单的代理缓存仍直读指定 Cookie。
  const appApi = await load.runInNewContext({...environment,config:{runsInApp:true,runsInWidget:false}});
  const AppWidget=appApi.createWidgetClass(MockDmYY);
  // 点击两种尺寸的卡片均直接查询并展示对应预览，不经过配置入口。
  for(const family of ['small','medium']) {
    const tapApi=await load.runInNewContext({...environment,config:{runsInApp:true,runsInWidget:false},args:{queryParameters:{ufRefresh:'1',ufFamily:family}}});
    const prior=requestCount;
    await tapApi.main();
    assert.equal(requestCount,prior+2);
    const message=feedback.at(-1);
    assert.equal(message.requestsAtOpen,prior);assert.equal(message.presented,true);
    assert.ok(message.html.includes('正在刷新'));assert.ok(message.updates.join('').includes('刷新成功'));
    assert.equal(widget.url,undefined); // 不覆盖系统配置的 Open App / Run Script / Open Script / Open URL
    assert.ok(widget.backgroundImage.includes('已刷新'));assert.ok(!widget.backgroundImage.includes('点击刷新'));
    if(family==='medium') {
      const areas=widget.children[0].children;
      assert.equal(areas.length,2);
      assert.equal(areas[1].size.width,44);
      const icon=areas[1].children[0], rest=areas[1].children[1];
      assert.equal(icon.size.width,44);assert.equal(icon.size.height,44);
      assert.equal(rest.size.height,114);
      assert.equal(rest.url,undefined);
      assert.ok(widget.backgroundImage.includes('↻'));
      assert.equal(areas[0].url,undefined);
      assert.equal(new URL(icon.url).searchParams.get('ufFamily'),'medium');
      assert.equal(new URL(icon.url).searchParams.get('ufRefresh'),'1');
    } else { assert.equal(widget.url,undefined);assert.equal(widget.children.length,0);assert.ok(!widget.backgroundImage.includes('↻')); }

  }
  apiError=true;
  const staleApi=await load.runInNewContext({...environment,config:{runsInApp:true,runsInWidget:false},args:{queryParameters:{ufRefresh:'1',ufFamily:'small'}}});
  await staleApi.main(); assert.ok(feedback.at(-1).updates.join('').includes('刷新失败'));assert.ok(widget.backgroundImage.includes('缓存')); assert.ok(!widget.backgroundImage.includes('点击刷新'));
  files.clear(); await staleApi.main(); assert.ok(widget.texts.length);assert.equal(widget.url,undefined);
  apiError=false;
  const before=requestCount;
  const instance=new AppWidget('');
  assert.equal(requestCount,before);
  const menus=instance._menuActions.flatMap(group=>group.menu);
  assert.equal(new Set(menus.map(item=>item.name)).size,menus.length);
  assert.ok(menus.some(item=>item.title==='组件主题' && item.options.join(',')==='黑色,白色'));
  assert.ok(menus.some(item=>item.title==='显示方式' && item.options.join(',')==='统一显示,主副卡分开显示'));
  assert.ok(menus.some(item=>item.title==='主副卡用量'));
  assert.ok(menus.some(item=>item.title==='本月用量'));
  const queriesBeforeMonthly=requestCount;
  await instance.showMonthlyUsage();
  assert.equal(requestCount,queriesBeforeMonthly+2);
  assert.ok(feedback.at(-1).html.includes('本月用量'));
  apiError=true;await instance.showMonthlyUsage();
  assert.ok(feedback.at(-1).html.includes('当前为缓存'));
  apiError=false;

  assert.ok(menus.some(item=>item.title==='账户设置'));
  assert.ok(menus.some(item=>item.title==='代理缓存'));
  assert.ok(menus.some(item=>item.title==='颜色配置'));
  assert.ok(menus.some(item=>item.title==='重载组件'));
  assert.ok(menus.some(item=>item.title==='脚本更新'));
  const configPage=await instance.renderAppView(instance._menuActions);
  assert.equal(configPage.avatar,false);
  const basic=await instance.basicSettings();
  assert.ok(basic.options[0].menu.some(item=>item.val==='flowBoxjsDomain'));
  const colors=await instance.colorSettings();
  assert.equal(colors.options[0].menu.length,4);
  assert.equal(colors.options[0].menu[0].val,'blackCardColor');
  instance.settings.theme='白色';
  const lightColors=await instance.colorSettings();
  assert.equal(lightColors.options[0].menu[0].val,'whiteCardColor');
  assert.equal(lightColors.options[0].menu[0].defaultValue,'#FFFFFF');
  apiError=false;
  instance.settings.flowBoxjsDomain='boxjs.com';
  instance.settings.flowBarColor='#ABCDEF';
  await instance.renderSmall(); assert.equal(instance.widgetFamily,'small');
  await instance.renderMedium(); assert.equal(instance.widgetFamily,'medium');
  const fontMenu=instance._menuActions.flatMap(group=>group.menu).find(item=>item.val==='numberFont');
  assert.equal(fontMenu.options.join(','),'SF Mono Regular,Menlo Regular');
  for(const theme of ['黑色','白色']) {
    instance.settings.theme=theme;
    for(const [label,fontFamily] of [['SF Mono Regular','Menlo,monospace'],['Menlo Regular','Menlo-Regular']]) {
      instance.settings.numberFont=label;
      for(const family of ['small','medium']) {
        const fontWidget=family==='small'?await instance.renderSmall():await instance.renderMedium();
        const numericTexts=[...fontWidget.backgroundImage.matchAll(/<text[^>]*font-family="([^"]+)" font-weight="400"[^>]*>([^<]+)<\/text>/g)].filter(m=>m[1]===fontFamily).map(m=>m[2]);
        assert.ok(numericTexts.some(value=>value.endsWith('GB')));
        assert.ok(numericTexts.some(value=>value.includes('%')));
      }
    }
  }
  for(const [oldFont,expected] of [['SF Mono Semibold（半粗体）','SF Mono Regular'],['SF Mono Medium（中等）','SF Mono Regular'],['系统等宽','SF Mono Regular'],['SF Pro Light（细体）','SF Mono Regular'],[undefined,'SF Mono Regular'],['未知字体','SF Mono Regular'],['Menlo','Menlo Regular'],['Menlo Regular','Menlo Regular']]) {
    class LegacyFontDmYY extends MockDmYY {constructor(arg){super(arg);this.settings.numberFont=oldFont;}}
    const LegacyFontWidget=appApi.createWidgetClass(LegacyFontDmYY);
    const migratedFont=new LegacyFontWidget('');
    assert.equal(migratedFont.settings.numberFont,expected);
  }
  unavailableFont=true; instance.settings.numberFont='Menlo Regular';
  const fallbackFontWidget=await instance.renderSmall();
  assert.ok(fallbackFontWidget.backgroundImage.includes('font-family="Menlo,monospace" font-weight="400" font-size="22"'));
  unavailableFont=false;
  instance.settings.numberFont='SF Mono Regular';

  assert.ok(!JSON.stringify(instance.settings).includes('FAKE_TEST_ONLY'));
  files.delete('/documents/UnicomFlow/history.json'); dataPayload=cardFixture;
  alertChoices.push(1); await instance.showMembers();
  assert.equal(alerts.at(-1).title,'副卡 130****0002');assert.ok(alerts.at(-1).message.includes('2.0GB'));
  assert.ok(!alerts.at(-1).message.includes('13000000002'));
  assert.ok(!Array.from(files.values()).join('').includes('13000000002'));
  files.delete('/documents/UnicomFlow/history.json'); dataPayload=fixture();await instance.showMembers();assert.match(alerts.at(-1).message,/未识别到成员用量/);
  instance.settings.flowBoxjsDomain='https://wrong/path';
  assert.throws(()=>instance.applySettings(),/域名格式/);
  assert.ok(!Array.from(files.values()).join('').includes('FAKE_TEST_ONLY'));
  // 开发阶段同步：内容不同时直接替换，无版本号要求、无第二次确认、无备份。
  appApi.validateUpdateSource(source);
  appApi.validateUpdateSource(source.replace(/^const UF_VERSION.*$/m,''));
  assert.throws(()=>appApi.validateUpdateSource('<html>error</html>'),/不是完整/);
  assert.throws(()=>appApi.validateUpdateSource(source+'\nconst broken = ;'),/语法/);
  const path='/documents/联通流量.js';
  files.set(path,source);
  await instance.checkAndUpdateScript(); assert.equal(alerts.at(-1).title,'同步完成');
  const beforeUpdateFiles=Array.from(files.keys()).sort();
  updateSource=source.replace(/^const UF_VERSION.*$/m,'')+'\n// changed content\n';
  const beforeAlerts=alerts.length;
  await instance.checkAndUpdateScript(); assert.equal(files.get(path),updateSource);
  assert.equal(alerts.length,beforeAlerts+1);assert.equal(alerts.at(-1).title,'同步完成');
  assert.deepEqual(Array.from(files.keys()).sort(),beforeUpdateFiles);
  files.set(path,source); cloudFile=true;const downloadsBefore=cloudDownloads;
  await instance.checkAndUpdateScript(); assert.equal(cloudDownloads,downloadsBefore+1);assert.equal(files.get(path),updateSource);
  files.set(path,source); failScriptWrite=true;
  await instance.checkAndUpdateScript(); assert.equal(alerts.at(-1).title,'更新未完成');
  assert.match(alerts.at(-1).message,/从仓库重新下载/);
  files.set(path,source);
  updateSource=new Error('download failed'); await instance.checkAndUpdateScript(); assert.equal(files.get(path),source);
  updateSource='<html>error</html>'; await instance.checkAndUpdateScript(); assert.equal(files.get(path),source);
  console.log('PASS: 本月日聚合/跨日未分配/零与缺失/旧记录迁移/两个月保留/日期交互/离线缓存、主副卡数据隔离/脱敏/缺失和冲突、抓包结构/镜像去重/角色标记/排除语音短信成员、请求主机与表单体/过期 Cookie 提示/表单失败回退、刻度居中/整卡背景、圆角安全留白/不同尺寸布局、无版本直接同步/校验/直接替换/本地与iCloud、黑白主题、共享/非共享分布、自动与手动分组、套餐解析、单位、重复共享包、缺失字段、分类、历史回退/跨月/跨日、会话隔离、乱序、原生绘图、首次运行/断网缓存、DmYY 分组菜单与尺寸预览、配置页不查询账号及 Cookie 不落盘。');
})();
