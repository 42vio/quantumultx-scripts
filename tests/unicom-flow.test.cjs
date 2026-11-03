const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scriptable/UnicomFlow.js'), 'utf8');
const load = new vm.Script('(async () => {' + source + '\nreturn {parsePackages, megabytes, formatMB, updateHistory, todayBuckets, sessionTag, renderImage, applyTheme, displayMetrics, createWidgetClass, validateUpdateSource, newerVersion, installUpdate, main};})()');

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
  const distribution=parsePackages(distributionFixture());
  assert.equal(distribution.categories.directed,null); // 两项均为通用，不冒充定向
  assert.equal(distribution.categories.general.total,200*1024);
  assert.ok(Math.abs(distribution.categories.general.used/1024-12.03)<1e-9);
  const split=api.displayMetrics(distribution);
  assert.equal(split.leftLabel,'共享通用'); assert.equal(split.rightLabel,'非共享通用');
  assert.equal(split.left.total,120*1024); assert.equal(split.right.total,80*1024);
  assert.equal(formatMB(split.left.used),'3.22GB'); assert.equal(formatMB(split.right.used),'8.81GB');
  const insideResources=distributionFixture(); insideResources.resources[0].details.push(insideResources.unshared[0].details[0]);delete insideResources.unshared;
  assert.equal(api.displayMetrics(parsePackages(insideResources)).right.total,80*1024); // 赠送包名称识别
  const forced=parsePackages(fixture(),{[base.packages[0].id]:'shared',[base.packages[1].id]:'exclusive'});
  assert.equal(api.displayMetrics(forced).rightLabel,'非共享通用');
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

  // 真正的原生绘图代码在 mock 中执行，将相同绘图指令输出为 SVG 供视觉检查。
  const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  class Color { constructor(hex) { this.hex = '#' + hex; } static white() { return new Color('FFFFFF'); } }
  class Rect { constructor(x,y,width,height) { Object.assign(this,{x,y,width,height}); } }
  class Size { constructor(width,height) { Object.assign(this,{width,height}); } }
  class Path { addRoundedRect(rect, rx) { this.rect = rect; this.rx = rx; } }
  class DrawContext {
    constructor() { this.parts=[]; }
    setFillColor(c) { this.fill=c.hex; } setTextColor(c) { this.text=c.hex; }
    setFont(f) { this.font=f; } setTextAlignedLeft() {}
    fillRect(r) { this.parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${this.fill}"/>`); }
    addPath(p) { this.path=p; }
    fillPath() { const r=this.path.rect; this.parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${this.path.rx}" fill="${this.fill}"/>`); }
    drawTextInRect(t,r) { this.parts.push(`<text x="${r.x}" y="${r.y+this.font.size}" fill="${this.text}" font-family="${this.font.mono?'Menlo,monospace':'sans-serif'}" font-size="${this.font.size}">${esc(t)}</text>`); }
    getImage() { assert.ok(this.parts.length); return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.size.width*3}" height="${this.size.height*3}" viewBox="0 0 ${this.size.width} ${this.size.height}"><defs><clipPath id="card"><rect width="100%" height="100%" rx="20"/></clipPath></defs><g clip-path="url(#card)">${this.parts.join('')}</g></svg>`; }
  }
  const Font = { regularMonospacedSystemFont: size => ({size,mono:true}), mediumSystemFont:size=>({size}) };
  const visual = await load.runInNewContext({ UNICOM_FLOW_TEST: true, Color, Rect, Size, Path, DrawContext, Font });
  const output = '/private/tmp/unicom-flow-preview'; fs.mkdirSync(output,{recursive:true});
  const visualAt = Date.now();
  const history = updateHistory(null, { ...distribution, at: visualAt, session:'preview' });
  history.events = [8,12,16,17,18,19,20].filter(hour => hour <= new Date().getHours()).map((hour,i)=>({
    from:new Date(new Date().setHours(hour,0,0,0)).getTime(), at:new Date(new Date().setHours(hour,30,0,0)).getTime(), mb:[30,85,40,260,240,280,150][i] }));
  for (const [name,medium,width,height] of [['small',false,158,158],['medium',true,338,158]]) {
    fs.writeFileSync(`${output}/${name}.svg`,visual.renderImage({history,stale:false},medium,width,height));
    fs.writeFileSync(`${output}/${name}-empty.svg`,visual.renderImage({history:{...history,events:[],data:{...base,categories:{general:base.categories.general,directed:null},at:visualAt}},stale:true},medium,width,height));
  }

  // 小号在不同手机尺寸下使用相同的安全留白，正常状态省略贴近圆角的页脚。
  for (const side of [141,158,170]) {
    const image=visual.renderImage({history,stale:false},false,side,side);
    assert.ok(!image.includes('已用 / 总量'));
    const textPositions=[...image.matchAll(/<text x="([0-9.]+)" y="([0-9.]+)"/g)];
    assert.ok(textPositions.length>=6);
    assert.ok(textPositions.every(m=>Number(m[1])>=20&&Number(m[2])>=17&&Number(m[2])<=140));
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
  const files=new Map(); let requestCount=0, widget=null, completed=0, apiError=false;
  let updateSource=source, cloudFile=false, cloudDownloads=0, failScriptWrite=false;
  const alertChoices=[], alerts=[];
  class FileManager {
    static local(){return new FileManager();} static iCloud(){return new FileManager();}
    isFileStoredIniCloud(){return cloudFile;} async downloadFileFromiCloud(){cloudDownloads++;} documentsDirectory(){return '/documents';} joinPath(a,b){return a+'/'+b;}
    fileExists(p){return p.endsWith('/UnicomFlow')||files.has(p);} createDirectory(){} readString(p){return files.get(p);}
    writeString(p,v){if(failScriptWrite && p==='/documents/联通流量.js'){failScriptWrite=false;files.set(p,'partial');throw new Error('write failed');} files.set(p,v);} remove(p){files.delete(p);}
  }
  class Request {
    constructor(url){this.url=url;}
    async loadString(){assert.ok(this.url.startsWith('https://raw.githubusercontent.com/42vio/quantumultx-scripts/main/scriptable/UnicomFlow.js?'));if(updateSource instanceof Error)throw updateSource;return updateSource;}
    async loadJSON(){requestCount++; if(this.url.includes('/query/data/')) return {val:'JSESSIONID=FAKE_TEST_ONLY;'};
      if(apiError)throw new Error('offline'); return fixture();}
  }
  class ListWidget {
    setPadding(){} addImage(){return {};} addText(){return {};} addSpacer(){}
  }
  class Alert {
    addAction(){} addCancelAction(){}
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
    FileManager, Request, ListWidget, Color, Rect, Size, Path, DrawContext, Alert, module:{filename:'/documents/联通流量.js'},
    Font:{...Font,boldSystemFont:size=>({size}),systemFont:size=>({size})}, Device:{screenSize:()=>({width:390,height:844})},
    Script:{name:()=> '联通流量',setWidget:w=>{widget=w;},complete:()=>{completed++;}} };
  const integration = await load.runInNewContext(environment);
  await integration.main(); assert.equal(requestCount,2); assert.equal(completed,1); assert.ok(widget);
  apiError=true; await integration.main(); assert.equal(completed,2); assert.ok(widget);
  files.clear(); await integration.main(); assert.equal(completed,3); assert.ok(widget);
  assert.ok(!Array.from(files.values()).join('').includes('FAKE_TEST_ONLY'));
  // App 打开配置页不查账号；DnYY 分组菜单的代理缓存仍直读指定 Cookie。
  const appApi = await load.runInNewContext({...environment,config:{runsInApp:true,runsInWidget:false}});
  const AppWidget=appApi.createWidgetClass(MockDmYY);
  const before=requestCount;
  const instance=new AppWidget('');
  assert.equal(requestCount,before);
  const menus=instance._menuActions.flatMap(group=>group.menu);
  assert.equal(new Set(menus.map(item=>item.name)).size,menus.length);
  assert.ok(menus.some(item=>item.title==='组件主题' && item.options.join(',')==='黑色,白色'));
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
  assert.ok(!JSON.stringify(instance.settings).includes('FAKE_TEST_ONLY'));
  instance.settings.flowBoxjsDomain='https://wrong/path';
  assert.throws(()=>instance.applySettings(),/域名格式/);
  assert.ok(!Array.from(files.values()).join('').includes('FAKE_TEST_ONLY'));
  // 比较版本号；取消和下载校验失败不写入，不创建备份。
  assert.equal(appApi.validateUpdateSource(source),'1.0.2');
  assert.equal(appApi.newerVersion('1.0.10','1.0.9'),true);
  assert.equal(appApi.newerVersion('1.0.1','1.0.1'),false);
  assert.equal(appApi.newerVersion('1.0.0','1.0.1'),false);
  assert.throws(()=>appApi.validateUpdateSource('<html>error</html>'),/不是完整/);
  assert.throws(()=>appApi.validateUpdateSource(source+'\nconst broken = ;'),/语法/);
  const path='/documents/联通流量.js';
  files.set(path,source);
  await instance.checkAndUpdateScript(); assert.equal(alerts.at(-1).title,'无需更新');
  const beforeUpdateFiles=Array.from(files.keys()).sort();
  updateSource=source.replace("const UF_VERSION = '1.0.2';","const UF_VERSION = '1.0.3';");
  alertChoices.push(-1); await instance.checkAndUpdateScript(); assert.equal(files.get(path),source);
  await instance.checkAndUpdateScript(); assert.equal(files.get(path),updateSource);
  assert.equal(alerts.at(-1).title,'更新成功');
  assert.deepEqual(Array.from(files.keys()).sort(),beforeUpdateFiles); // 只有当前文件被覆盖
  files.set(path,source); cloudFile=true;
  await instance.checkAndUpdateScript(); assert.equal(cloudDownloads,1);assert.equal(files.get(path),updateSource);
  files.set(path,source); failScriptWrite=true;
  await instance.checkAndUpdateScript(); assert.equal(alerts.at(-1).title,'更新未完成');
  assert.match(alerts.at(-1).message,/从仓库重新下载/);
  files.set(path,source);
  updateSource=new Error('download failed'); await instance.checkAndUpdateScript(); assert.equal(files.get(path),source);
  updateSource='<html>error</html>'; await instance.checkAndUpdateScript(); assert.equal(files.get(path),source);
  console.log('PASS: 圆角安全留白/不同尺寸布局、更新版本比较/校验/取消/直接替换/本地与iCloud、黑白主题、共享/非共享分布、自动与手动分组、套餐解析、单位、重复共享包、缺失字段、分类、历史回退/跨月/跨日、会话隔离、乱序、原生绘图、首次运行/断网缓存、DmYY 分组菜单与尺寸预览、配置页不查询账号及 Cookie 不落盘。');
})();
