const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scriptable/UnicomFlow.js'), 'utf8');
const load = new vm.Script('(async () => {' + source + '\nreturn {previewHTML, refreshRecords, queryDeadline, reusableHistory, refresh, storage, makeWidget, widgetMode, formatGB, todayPackageUsage, yearlyReport, cardDelta, monthlyReport, hourlyReport, statisticsReports, statisticsHTML, parsePackages, megabytes, formatMB, updateHistory, todayBuckets, sessionTag, memberStructure, renderImage, applyTheme, displayMetrics, sharedComposition, createWidgetClass, validateUpdateSource, installUpdate, main};})()');

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
  // 请求时间与流量增量分开保存：真实零值、跨日及计数回退仍记录成功请求。
  const logAt=new Date(2026,10,5,12).getTime();
  const logSample=(at,extra={})=>({...base,at,session:'query-log-test',...extra});
  let queryHistory=updateHistory(null,logSample(logAt-8*86400000));
  queryHistory=updateHistory(queryHistory,logSample(logAt-25*3600000));
  queryHistory=updateHistory(queryHistory,logSample(logAt-23*3600000));
  queryHistory=updateHistory(queryHistory,logSample(logAt-3600000));
  assert.equal(queryHistory.queryTimes.length,3); // 七天裁剪，零增量同样记录
  const queryReport=api.refreshRecords(queryHistory,logAt);
  assert.equal(queryReport.count,2);assert.equal(queryReport.rows[0].interval,22*3600000);
  assert.equal(queryReport.average,12*3600000);assert.equal(queryReport.longest,22*3600000);
  assert.equal(updateHistory(queryHistory,logSample(logAt-3600000)),queryHistory); // 重复时间不追加
  const resetQuery=updateHistory(queryHistory,logSample(logAt,{packages:base.packages.map(p=>({...p,used:0}))}));
  assert.equal(resetQuery.queryTimes.length,4);assert.equal(resetQuery.events.length,0);
  const changedQuery=updateHistory(resetQuery,logSample(logAt+1,{session:'other-account'}));
  assert.equal(changedQuery.queryTimes.length,1); // 换号隔离
  const legacyLog={...queryHistory};delete legacyLog.queryTimes;
  const migratedLog=updateHistory(legacyLog,logSample(logAt));
  assert.deepEqual(Array.from(migratedLog.queryTimes),[logAt-25*3600000,logAt-23*3600000,logAt-3600000,logAt]); // 复用旧区间实际采样时间
  assert.equal(api.refreshRecords({data:{at:logAt-8*86400000},events:[{at:logAt}]},logAt).count,0);
  assert.equal(api.refreshRecords({data:{at:logAt},queryTimes:[logAt,logAt+1,NaN]},logAt).count,1);
  assert.equal(api.refreshRecords({data:{at:logAt}},logAt).average,null);
  const oldRefresh={data:{at:logAt},last:{at:logAt},events:[
    {from:logAt-7200000,at:logAt-3600000,mb:0},
    {from:logAt-3600000,at:logAt,mb:1},
    {from:logAt+1,at:logAt+2}, {from:logAt,at:logAt-1}],
    months:{'2026-11':{days:{},crossDay:[{from:logAt-13*3600000,at:logAt-11*3600000,mb:0,mainMB:0,viceMB:0,unknownMB:0}]}}};
  const oldRefreshReport=api.refreshRecords(oldRefresh,logAt);
  assert.equal(oldRefreshReport.count,5); // 读取旧数据即可显示，不必等待新查询
  assert.equal(oldRefreshReport.rows[0].interval,3600000);
  const recoveredRefresh=updateHistory({...oldRefresh,version:1,cardHistoryVersion:1,session:'query-log-test',last:null},logSample(logAt+1));
  assert.equal(recoveredRefresh.queryTimes.length,6); // 新查询持久保留恢复的时间
  assert.equal(api.refreshRecords({...oldRefresh,queryTimes:[logAt,logAt-3600000]},logAt).count,5); // 去重


  const cardFixture=distributionFixture();
  cardFixture.viceCardLits=[{number:'13000000001',role:'main'}, {number:'13000000002',role:'vice'}];
  cardFixture.resources[0].details[0].viceCardlist=[{number:'13000000001',use:1.22*1024},{number:'13000000002',use:2*1024,currentLoginFlag:'1'}];
  const cards=parsePackages(cardFixture);
  const c=api.displayMetrics(cards).right.composition;
  assert.equal(c.complete,true);assert.equal(c.main,1.22*1024);assert.equal(c.vice,2*1024);
  assert.equal(api.displayMetrics(cards).leftLabel,'主卡独享');
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

  assert.equal(api.displayMetrics(base).left,base.categories.general);

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
  const capturedMetrics=api.displayMetrics(capturedData);
  assert.equal(capturedMetrics.leftLabel,'主卡独享');assert.equal(capturedMetrics.rightLabel,'共享流量');
  assert.equal(capturedMetrics.right.used,3.22*1024);assert.equal(capturedMetrics.left.used,8.81*1024);

  const distribution=parsePackages(distributionFixture());
  assert.equal(distribution.categories.directed,null); // 两项均为通用，不冒充定向
  assert.equal(distribution.categories.general.total,200*1024);
  assert.ok(Math.abs(distribution.categories.general.used/1024-12.03)<1e-9);
  const split=api.displayMetrics(distribution);
  assert.equal(split.leftLabel,'主卡独享'); assert.equal(split.rightLabel,'共享流量');
  assert.equal(split.right.total,120*1024); assert.equal(split.left.total,80*1024);
  assert.equal(formatMB(split.right.used),'3.2GB'); assert.equal(formatMB(split.left.used),'8.8GB');
  const insideResources=distributionFixture(); insideResources.resources[0].details.push(insideResources.unshared[0].details[0]);delete insideResources.unshared;
  assert.equal(api.displayMetrics(parsePackages(insideResources)).left.total,80*1024); // 赠送包名称识别
  const forced=parsePackages(fixture(),{[base.packages[0].id]:'shared',[base.packages[1].id]:'exclusive'});
  assert.equal(api.displayMetrics(forced).leftLabel,'主卡独享');
  assert.equal(api.displayMetrics(base).leftLabel,'通用'); // 无可靠共享信息时不猜测
  const extra=distributionFixture();extra.mlresources=[{type:'flow',details:[{feePolicyId:'other',feePolicyName:'定向',total:1,use:0.01,remain:0.99}]}];
  assert.equal(api.displayMetrics(parsePackages(extra)).omitted,true);

  assert.equal(base.packages.length, 2);
  assert.equal(base.categories.general.used, 2355.2);
  assert.equal(base.categories.directed.used, 38604.8);
  assert.equal(formatMB(base.categories.general.used), '2.3GB');
  assert.equal(formatMB(null), '—');
  assert.equal(formatMB(12.03*1024),'12.0GB');assert.equal(formatMB(37.77*1024),'37.8GB');
  assert.equal(formatMB(515.27),'515.27MB');assert.equal(formatMB(9.87*1024),'9.9GB');
  assert.equal(formatMB(10.39),'10.39MB');assert.equal(formatMB(10.39*1024),'10.4GB');
  assert.equal(formatMB(10.01),'10.01MB');assert.equal(formatMB(10),'10.00MB');
  assert.equal(formatMB(0.0999,'daily'),'<0.1MB');
  assert.equal(formatMB(null,'daily'),'—');
  assert.equal(formatMB(0.1,'daily'),'0.1MB');assert.equal(formatMB(0.53,'daily'),'0.5MB');
  assert.equal(formatMB(0.09,'daily'),'<0.1MB');assert.equal(formatMB(0.001,'daily'),'<0.1MB');
  assert.equal(formatMB(0),'0MB');assert.equal(formatMB(0,'daily'),'0MB');
  assert.equal(formatMB(0.03),'0.03MB');assert.equal(formatMB(0.03,'daily'),'<0.1MB');
  assert.equal(formatMB(954.53),'954.53MB');assert.equal(formatMB(954.53,'daily'),'954.5MB');
  assert.equal(formatMB(1.23*1024,'daily'),'1.2GB');assert.equal(formatMB(10.39*1024,'daily'),'10.4GB');
  assert.equal(formatMB(120*1024,'total'),'120GB');assert.equal(formatMB(500,'total'),'500MB');
  assert.equal(formatMB(80.5*1024,'total'),'80.5GB');assert.equal(formatMB(0.03,'total'),'0.03MB');
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

  // 逐卡增量必须按每个套餐核对；主卡包含独享包，副卡仅计明确返回的共享用量。
  const cardSample=(time,main,vice,own,roles=true)=>{
    const raw=distributionFixture();
    raw.resources[0].details[0].use=main+vice;
    raw.resources[0].details[0].remain=120*1024-main-vice;
    raw.resources[0].details[0].viceCardlist=[{number:'13000000001',use:main},{number:'13000000002',use:vice}];
    if(roles)raw.viceCardLits=[{number:'13000000001',role:'main'},{number:'13000000002',role:'vice'}];
    raw.unshared[0].details[0].use=own;raw.unshared[0].details[0].remain=80*1024-own;
    return {...parsePackages(raw),session:'cards',at:time};
  };
  const cardStart=updateHistory(null,cardSample(at,100,200,300));
  const cardNext=updateHistory(cardStart,cardSample(at+3600000,110,230,350));
  assert.equal(cardNext.events[0].mb,90);assert.equal(cardNext.events[0].mainMB,60);
  assert.equal(cardNext.events[0].viceMB,30);assert.equal(cardNext.events[0].unknownMB,0);
  const retainedCards=updateHistory(cardNext,cardSample(at+7200000,120,240,360));
  assert.equal(retainedCards.events.length,2);assert.equal(retainedCards.events[0].mb,90);
  assert.equal(retainedCards.events[1].mainMB,20);assert.equal(retainedCards.events[1].viceMB,10);

  const {leftIds:exclusiveIds,rightIds:sharedIds}=api.displayMetrics(cardNext.data);
  assert.equal(api.todayPackageUsage(cardNext,sharedIds,at+3600000),null);
  assert.equal(api.todayPackageUsage(cardNext,exclusiveIds,at+3600000),null);
  assert.equal(api.todayPackageUsage(cardStart,sharedIds,at),null);
  const noPackageHistory={...cardNext,events:cardNext.events.map(({packageDeltas,...event})=>event)};
  assert.equal(api.todayPackageUsage(noPackageHistory,sharedIds,at+3600000),null);
  const zeroPackages=updateHistory(cardNext,cardSample(at+7200000,110,230,350));
  assert.equal(api.todayPackageUsage({...zeroPackages,events:zeroPackages.events.slice(-1)},sharedIds,at+7200000),0); // 总增量为零时，各套餐也均为零
  assert.equal(api.todayPackageUsage(cardNext,sharedIds,at),null); // 不计未来事件
  assert.equal(api.todayPackageUsage(cardNext,sharedIds,midnight),null); // 不计昨天
  assert.equal(api.todayPackageUsage(cardNext,[],at+3600000),null);
  const invalidPackages={...cardNext,events:cardNext.events.map(e=>({...e,mb:-1}))};
  assert.equal(api.todayPackageUsage(invalidPackages,sharedIds,at+3600000),null);
  for(const [value,expected] of [[6.8*1024,'6.8'],[0.53*1024,'0.53'],[0.001*1024,'<0.01'],[0,'0'],[null,'—']]) assert.equal(api.formatGB(value),expected);
  assert.equal(api.formatGB(120*1024,true),'120');assert.equal(api.formatGB(80.5*1024,true),'80.5');
  for(const [parameter,mode] of [['','month'],['month','month'],[' today ','today'],['TODAY','today'],['unknown','month']]) assert.equal(api.widgetMode(parameter),mode);
  assert.equal(formatMB(0.001,'daily'),'<0.1MB');
  const reusableStart=updateHistory(null,cardSample(at,0,200,300));
  const reusable=updateHistory(reusableStart,cardSample(at+3600000,0,230,350));
  const {leftIds:reusableExclusiveIds,rightIds:reusableSharedIds}=api.displayMetrics(reusable.data);
  assert.equal(api.todayPackageUsage(reusable,reusableSharedIds,at+3600000),30);
  assert.equal(api.todayPackageUsage(reusable,reusableExclusiveIds,at+3600000),50);
  const sharedUnknown={...reusable,events:reusable.events.map(e=>({...e,viceMB:20,unknownMB:10}))};
  assert.equal(api.todayPackageUsage(sharedUnknown,reusableSharedIds,at+3600000),30);
  assert.equal(api.todayPackageUsage(sharedUnknown,reusableExclusiveIds,at+3600000),50);
  assert.ok(!JSON.stringify(reusable).includes('packageDeltas'));
  const unchanged=updateHistory(reusable,cardSample(at+7200000,0,230,350));
  assert.equal(api.todayPackageUsage(unchanged,reusableSharedIds,at+7200000),30); // 新增零区间不能覆盖旧的今日正用量
  const reusedZero={...unchanged,events:unchanged.events.slice(-1)};
  assert.equal(api.todayPackageUsage(reusedZero,reusableSharedIds,at+7200000),0);
  const missingCardParts={...reusable,events:reusable.events.map(({mainMB,viceMB,unknownMB,...e})=>e)};
  assert.equal(api.todayPackageUsage(missingCardParts,reusableSharedIds,at+3600000),null);
  const withRedundant={...reusable,events:reusable.events.map(e=>({...e,packageDeltas:[{id:'extra',mb:999}]}))};
  const cleaned=updateHistory(withRedundant,cardSample(at+7200000,0,230,350));
  assert.ok(!JSON.stringify(cleaned).includes('packageDeltas'));assert.equal(cleaned.events[0].mb,reusable.events[0].mb);
  assert.equal(api.todayPackageUsage(reusable,reusable.data.packages.map(p=>p.id),at+3600000),80);
  const mixedGroups={...reusable,data:{...reusable.data,packages:[...reusable.data.packages,{id:'directed',category:'directed',used:99}]}};
  assert.equal(api.todayPackageUsage(mixedGroups,reusableSharedIds,at+3600000),null);
  const cardBuckets=todayBuckets(cardNext,at);
  assert.equal(cardBuckets[11].mainMB,60);assert.equal(cardBuckets[11].viceMB,30);
  const cardMonth=api.monthlyReport(cardNext,at);
  assert.equal(cardMonth.days[2].mainMB,60);assert.equal(cardMonth.days[2].viceMB,30);
  const unknownCard=updateHistory(cardStart,cardSample(at+3600000,110,230,350,false));
  assert.equal(api.todayPackageUsage(unknownCard,sharedIds,at+3600000),null); // 归属不完整时不猜测
  assert.equal(unknownCard.events[0].mainMB,50);assert.equal(unknownCard.events[0].unknownMB,40);
  const memberRollback=updateHistory(cardStart,cardSample(at+3600000,90,250,350));
  assert.equal(memberRollback.events[0].mainMB,50);assert.equal(memberRollback.events[0].unknownMB,40);
  const cardCross=updateHistory(cardNext,cardSample(midnight,120,240,360));
  const crossParts=api.monthlyReport(cardCross,midnight).crossDay[0];
  assert.equal(crossParts.mainMB,20);assert.equal(crossParts.viceMB,10);
  const oldHistory={...cardNext,version:1,cardHistoryVersion:undefined};
  const wipedHistory=updateHistory(oldHistory,cardSample(at+7200000,130,250,370));
  assert.equal(wipedHistory.events.length,0);assert.equal(api.monthlyReport(wipedHistory,at).totalMB,null);
  assert.equal(wipedHistory.cardHistoryVersion,1);

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
  assert.equal(monthReport.totalMB,40);assert.equal(monthReport.dayTotalMB,10);assert.equal(monthReport.days[3].mb,null);
  assert.equal(monthReport.unallocatedMB,30);assert.equal(monthReport.crossDay.length,1);
  assert.ok(monthReport.days[2].notes.includes('跨日区间未分配'));
  assert.ok(monthReport.days[3].notes.includes('跨日区间未分配'));
  const zero=updateHistory(cross,sample(midnight+3600000,20));
  assert.equal(api.monthlyReport(zero,midnight).days[3].mb,0);
  const rollback=updateHistory(zero,sample(midnight+7200000,1));
  monthReport=api.monthlyReport(rollback,midnight);
  assert.equal(monthReport.totalMB,40);assert.ok(monthReport.days[3].notes.some(n=>n.includes('回退')));
  const changed=updateHistory(zero,sample(midnight+7200000,22,1024));
  assert.equal(api.monthlyReport(changed,midnight).totalMB,40);
  const legacy={...monthHistory};delete legacy.months;delete legacy.cardHistoryVersion;
  const imported=updateHistory(legacy,sample(at+7200000,7));
  assert.equal(api.monthlyReport(imported,at).totalMB,null);
  assert.equal(api.monthlyReport(updateHistory(imported,sample(at+10800000,8)),at).totalMB,2);
  const separated=updateHistory(monthHistory,{...sample(at+7200000,7),session:'new-user'});
  assert.equal(api.monthlyReport(separated,at).totalMB,null);
  const afterSevenDays=updateHistory(monthHistory,sample(at+10*86400000,100));
  assert.equal(afterSevenDays.events.length,0);assert.equal(api.monthlyReport(afterSevenDays,at+10*86400000).totalMB,200);
  const december=updateHistory(monthHistory,sample(nextMonth,0));
  assert.ok(december.months['2026-11']);assert.ok(december.months['2026-12']);
  assert.equal(api.monthlyReport(december,nextMonth).totalMB,null);
  const january=new Date(2027,0,1,12).getTime();
  const januaryHistory=updateHistory(december,sample(january,0));
  assert.ok(januaryHistory.months['2026-11']);assert.ok(januaryHistory.months['2026-12']);
  assert.equal(api.monthlyReport(januaryHistory,january).days.length,31);
  const leap=new Date(2028,1,2,12).getTime();
  assert.equal(api.monthlyReport(updateHistory(null,sample(leap)),leap).days.length,29);
  // 旧版统计已获准删除，不显示或导入旧日记录。
  assert.equal(api.monthlyReport(legacy,at).totalMB,null);

  const yearCards=api.yearlyReport(cardCross,midnight);
  assert.equal(yearCards.days.length,12);assert.equal(yearCards.days[0].key,'2025-12');assert.equal(yearCards.days[11].key,'2026-11');
  assert.equal(yearCards.days[11].mainMB,80);assert.equal(yearCards.days[11].viceMB,40);
  assert.equal(yearCards.days[11].mb,120);assert.equal(yearCards.average.monthCount,0);assert.equal(yearCards.average.mb,null); // 90 同日 + 30 同月跨日，只计一次
  assert.equal(yearCards.days[0].mb,null);
  const zeroYear=api.yearlyReport(updateHistory(updateHistory(null,sample(at)),sample(at+3600000)),at);
  assert.equal(zeroYear.days[11].mb,0);assert.equal(zeroYear.average.mb,null);
  const nextNovember=new Date(2027,10,1,12).getTime();
  const boundaryHistory=updateHistory(januaryHistory,sample(nextNovember));
  assert.equal(boundaryHistory.months['2026-11'],undefined);assert.ok(boundaryHistory.months['2026-12']);
  const yearBoundary=api.yearlyReport(boundaryHistory,nextNovember);
  assert.equal(yearBoundary.days[0].key,'2026-12');assert.equal(yearBoundary.days[11].key,'2027-11');

  // 月均排除本月和无记录月份，真实零用量的已结束月份仍参与计算。
  const dailyUsage=(key,mainMB,viceMB,notes=[])=>({mb:mainMB+viceMB,mainMB,viceMB,unknownMB:0,intervals:1,
    first:new Date(key+'T00:00:00').getTime(),last:new Date(key+'T23:59:00').getTime(),notes});
  const averageHistory={...cardCross,months:{...cardCross.months,
    '2026-10':{days:{'2026-10-01':dailyUsage('2026-10-01',100,50),'2026-10-31':dailyUsage('2026-10-31',100,50)},crossDay:[]},
    '2026-09':{days:{'2026-09-03':dailyUsage('2026-09-03',0,0,['首次记录，仅建立基线'])},crossDay:[]},
    '2026-08':{days:{},crossDay:[]}}};
  const averageReport=api.yearlyReport(averageHistory,midnight);
  assert.equal(averageReport.average.monthCount,2);assert.equal(averageReport.average.mb,150);
  assert.equal(averageReport.average.mainMB,100);assert.equal(averageReport.average.viceMB,50);
  assert.equal(averageReport.average.partialMonthCount,1);
  assert.equal(averageReport.days.find(d=>d.key==='2026-10').partial,false);
  assert.equal(averageReport.days.find(d=>d.key==='2026-09').partial,true);
  assert.equal(averageReport.days[11].mb,120);assert.equal('totalMB' in averageReport,false);
  const matchingMonth=api.monthlyReport(cardCross,midnight);
  assert.equal(matchingMonth.totalMB,yearCards.days[11].mb);
  assert.equal(matchingMonth.summary.mainMB,80);assert.equal(matchingMonth.summary.viceMB,40);
  assert.equal(matchingMonth.dayTotalMB,90);assert.equal(matchingMonth.unallocatedMB,30);

  // 小时统计保留真实区间归属，未来事件不进入当前时段合计。
  const cardHours=api.hourlyReport(cardNext,at+2*3600000);
  assert.equal(cardHours.days.length,24);assert.equal(cardHours.days[11].mainMB,60);assert.equal(cardHours.days[11].viceMB,30);
  assert.equal(cardHours.totalMB,90);assert.ok(cardHours.days[11].notes[0].includes('结束小时'));
  assert.equal(cardHours.days[14].future,true);assert.equal(cardHours.days[10].mb,null);
  const futureHour={...cardNext,events:[...cardNext.events,{from:at+3*3600000,at:at+4*3600000,mb:100,mainMB:100,viceMB:0,unknownMB:0}]};
  assert.equal(api.hourlyReport(futureHour,at+2*3600000).totalMB,90);
  assert.equal(api.hourlyReport(cardCross,midnight).totalMB,null);assert.equal(api.hourlyReport(cardCross,midnight).unallocatedMB,30);

  // 日期切换使用真实当前时刻判定未来小时，历史日期全天均可查看。
  const browseAt=new Date(2026,10,5,12,30).getTime();
  const makeEvent=(day,hour,main,vice)=>({from:new Date(day+'T'+String(hour).padStart(2,'0')+':00:00').getTime(),at:new Date(day+'T'+String(hour).padStart(2,'0')+':30:00').getTime(),mb:main+vice,mainMB:main,viceMB:vice,unknownMB:0});
  const browsing={...averageHistory,events:[makeEvent('2026-10-29',8,900,0),makeEvent('2026-10-30',8,3,2),makeEvent('2026-11-04',9,60,30)],data:{...averageHistory.data,at:browseAt}};
  const originalBrowsing=JSON.stringify(browsing);
  const browseReports=api.statisticsReports(browsing,browseAt);
  assert.equal(JSON.stringify(browsing),originalBrowsing); // 生成选择器只读历史
  assert.equal(Object.keys(browseReports.dates).length,6);assert.ok(browseReports.dates['2026-10-30']);
  assert.equal(browseReports.dates['2026-10-29'],undefined);
  assert.equal(browseReports.dates['2026-11-04'].totalMB,90);
  assert.equal(browseReports.dates['2026-11-04'].days[23].future,false);
  assert.equal(browseReports.hours.totalMB,null);assert.equal(browseReports.hours.days[13].future,true);
  assert.equal(browseReports.months['2026-10'].totalMB,300);assert.equal(browseReports.months['2026-10'].days.length,31);
  assert.ok(browseReports.months['2026-10'].days.every(d=>!d.future));
  assert.equal(api.monthlyReport(browsing,browseAt,'2024-02').days.length,29);
  assert.equal(api.monthlyReport(browsing,browseAt,'2027-01').month,'2026-11');
  assert.equal(api.hourlyReport(browsing,browseAt,'2026-11-06').month,'2026-11-05');
  // 执行完整统计页脚本，验证同页切换、逐卡表格、缺失占位及图表选择。
  class Element {
    constructor(){this.children=[];this.dataset={};this.style={};this.attributes={};this.classes=new Set();this.classList={toggle:(key,value)=>value?this.classes.add(key):this.classes.delete(key)};}
    append(...items){this.children.push(...items);}replaceChildren(...items){this.children=[...items];}
    setAttribute(key,value){this.attributes[key]=value;}
  }
  const elements=new Map(),listeners=new Map();const doc={addEventListener:(type,handler)=>listeners.set(type,handler),getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:()=>new Element()};
  const previewImages={month:{small:'MONTH_SMALL',medium:'MONTH_MEDIUM'},today:{small:'TODAY_SMALL',medium:'TODAY_MEDIUM'}};
  const previewSizes={small:{width:158,height:158},medium:{width:338,height:158}};
  const previewPage=api.previewHTML(previewImages,previewSizes,'today');
  new vm.Script(previewPage.match(/<script>([\s\S]*?)<\/script>/)[1]).runInNewContext({document:doc});
  assert.equal(elements.get('preview-today').attributes['aria-pressed'],'true');
  assert.equal(elements.get('preview-small').src,'TODAY_SMALL');assert.equal(elements.get('preview-medium').src,'TODAY_MEDIUM');
  elements.get('preview-month').onclick();assert.equal(elements.get('preview-small').src,'MONTH_SMALL');assert.equal(elements.get('preview-medium').src,'MONTH_MEDIUM');
  assert.equal(elements.get('preview-today').attributes['aria-pressed'],'false');assert.ok(!previewPage.includes('fetch('));
  assert.ok(api.previewHTML(previewImages,previewSizes,'month',true).includes('上次成功查询的缓存数据'));
  elements.clear();

  // 默认进入今天，即使今天无记录也不自动跳转；切换周期同步汇总且不改变历史。
  const browsingHTML=api.statisticsHTML(browseReports);
  new vm.Script(browsingHTML.match(/<script>([\s\S]*?)<\/script>/)[1]).runInNewContext({document:doc});
  assert.equal(elements.get('tab-hours').attributes['aria-pressed'],'true');
  assert.equal(elements.get('period-select').value,'2026-11-05');assert.equal(elements.get('period-next').disabled,true);
  assert.equal(elements.get('chart').children.length,24);assert.equal(elements.get('total').textContent,'—');
  assert.ok(elements.get('coverage').textContent.includes('今日暂无有效采样'));
  elements.get('period-prev').onclick();
  assert.equal(elements.get('period-select').value,'2026-11-04');assert.equal(elements.get('total').textContent,'90.00 MB');
  assert.equal(elements.get('main-total').textContent,'60.00 MB');assert.equal(elements.get('vice-total').textContent,'30.00 MB');
  assert.ok(elements.get('period-label').textContent.startsWith('2026-11-04'));assert.ok(!elements.get('period-label').textContent.includes('今日'));
  elements.get('period-select').value='2026-10-30';elements.get('period-select').onchange();
  assert.equal(elements.get('total').textContent,'5.00 MB');assert.equal(elements.get('period-prev').disabled,true);
  elements.get('period-prev').onclick();assert.equal(elements.get('period-select').value,'2026-10-30');
  elements.get('period-select').value='2026-12-01';elements.get('period-select').onchange();
  assert.equal(elements.get('total').textContent,'5.00 MB'); // 无效日期不能切换
  elements.get('tab-month').onclick();
  assert.equal(elements.get('period-select').value,'2026-11');
  elements.get('period-prev').onclick();assert.equal(elements.get('period-select').value,'2026-10');
  assert.equal(elements.get('total').textContent,'300.00 MB');assert.equal(elements.get('main-total').textContent,'200.00 MB');
  assert.equal(elements.get('chart').children.length,31);assert.ok(elements.get('period-label').textContent.startsWith('2026-10'));
  elements.get('tab-year').onclick();assert.equal(elements.get('period-picker').hidden,true);
  assert.equal(elements.get('total').textContent,'150.00 MB');
  elements.get('tab-month').onclick();assert.equal(elements.get('period-select').value,'2026-10');
  elements.get('tab-hours').onclick();assert.equal(elements.get('period-select').value,'2026-10-30');
  assert.equal(JSON.stringify(browsing),originalBrowsing);assert.ok(!browsingHTML.includes('fetch('));
  // 打开与返回刷新记录不重建统计页，不丢失日期、柱子选择或滚动位置。
  elements.get('chart').children[2].onclick();const selectedBeforeLog=elements.get('selected').textContent;
  elements.get('refresh-records-toggle').onclick();
  assert.equal(elements.get('usage-content').hidden,true);assert.equal(elements.get('refresh-records').hidden,false);
  assert.equal(elements.get('page-title').textContent,'刷新记录');assert.equal(elements.get('refresh-records-toggle').textContent,'返回统计');
  elements.get('refresh-records-toggle').onclick();
  assert.equal(elements.get('usage-content').hidden,false);assert.equal(elements.get('refresh-records').hidden,true);
  assert.equal(elements.get('selected').textContent,selectedBeforeLog);assert.equal(elements.get('period-select').value,'2026-10-30');

  elements.clear();
  const html=api.statisticsHTML(api.statisticsReports(zero,midnight+3600000),true,'month');
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]).runInNewContext({document:doc});
  assert.equal(elements.get('chart').children.length,30);assert.equal(elements.get('rows').children.length,30);
  assert.ok(html.includes('user-scalable=no'));assert.ok(html.includes('touch-action:manipulation'));assert.ok(html.includes('padding:56px 18px 30px'));assert.ok(!html.includes('safe-area-inset-top'));
  assert.ok(!html.includes('.bar.selected{'));assert.ok(html.includes('.bar.selected .tick{background:var(--blue);color:#fff'));
  assert.ok(html.includes('>单日</button>'));assert.ok(html.includes('>月度趋势</button>'));
  let prevented=false;listeners.get('dblclick')({preventDefault:()=>{prevented=true;}});assert.equal(prevented,true);

  assert.ok(!html.includes('axis-max'));assert.ok(!html.includes('class="axis"'));
  elements.get('tab-hours').onclick();
  elements.get('tab-month').onclick();
  const monthBars=elements.get('chart').children;
  assert.equal(monthBars[0].children[0].style.height,'4px');assert.ok(monthBars[0].children[0].className.includes('missing'));
  assert.equal(monthBars[3].children[0].style.height,'4px');assert.equal(monthBars[3].children[0].className,'fill');
  assert.equal(monthBars[4].children[0].style.height,'0px');assert.ok(monthBars[4].children[0].className.includes('future'));
  assert.equal(elements.get('selected').textContent,'2026-11-04');assert.equal(elements.get('selected-total').textContent,'0 MB');
  elements.get('chart').children[1].onclick();assert.equal(monthBars[1].attributes['aria-pressed'],'true');assert.equal(monthBars[3].attributes['aria-pressed'],'false');assert.equal(elements.get('selected').textContent,'2026-11-02');assert.equal(elements.get('selected-total').textContent,'—');
  elements.get('rows').children[2].children[0].children[0].onclick();assert.equal(elements.get('selected').textContent,'2026-11-03');
  elements.get('tab-hours').onclick();assert.equal(elements.get('chart').children.length,24);assert.equal(elements.get('rows').children.length,24);
  assert.equal(elements.get('tab-hours').attributes['aria-pressed'],'true');assert.equal(elements.get('tab-month').attributes['aria-pressed'],'false');
  elements.get('tab-year').onclick();assert.equal(elements.get('chart').children.length,12);assert.equal(elements.get('rows').children.length,12);assert.equal(elements.get('chart').style.minWidth,'0px');
  elements.get('tab-month').onclick();assert.equal(elements.get('chart').children.length,30); // 未重复追加旧节点
  const malicious=api.statisticsHTML({month:{...monthReport,today:'</script><img src=x>'}});
  assert.equal((malicious.match(/<\/script>/g)||[]).length,1);assert.ok(!html.includes('13000000001'));assert.ok(html.includes('缓存数据'));assert.ok(html.includes('<meta charset="utf-8">'));
  api.applyTheme({theme:'白色'});assert.ok(api.statisticsHTML(api.statisticsReports(zero,midnight)).includes('color-scheme:light'));api.applyTheme({theme:'黑色'});
  elements.clear();
  const beforeReports=JSON.stringify(cardCross);
  const reports=api.statisticsReports(cardCross,midnight), cardsHTML=api.statisticsHTML(reports,false,'month');
  assert.equal(JSON.stringify(cardCross),beforeReports); // 只读视图不改写历史

  new vm.Script(cardsHTML.match(/<script>([\s\S]*?)<\/script>/)[1]).runInNewContext({document:doc});
  assert.equal(elements.get('total').textContent,'120.00 MB');assert.equal(elements.get('main-total').textContent,'80.00 MB');assert.ok(elements.get('cross-hint').textContent.includes('已计入所选月份合计'));
  assert.equal(elements.get('chart').children[2].children[0].style.height,'140px');
  const stackedMonth=elements.get('chart').children[2].children[0].children;
  assert.equal(stackedMonth.length,2);assert.equal(stackedMonth[0].style.background,'#0A94FF');assert.equal(stackedMonth[1].style.background,'#8A73FF');
  assert.ok(Math.abs(parseFloat(stackedMonth[0].style.height)-60/90*100)<1e-8);
  elements.get('chart').children[2].onclick();assert.equal(elements.get('selected-main').textContent,'主卡 60.00 MB');assert.equal(elements.get('selected-vice').textContent,'副卡 30.00 MB');
  const dailyRow=elements.get('rows').children[2].children;
  assert.equal(dailyRow.length,6);assert.equal(dailyRow[1].textContent,'60.00 MB');assert.equal(dailyRow[2].textContent,'30.00 MB');assert.equal(dailyRow[4].textContent,'90.00 MB');
  elements.get('tab-year').onclick();assert.equal(elements.get('rows').children[11].children[1].textContent,'80.00 MB');assert.equal(elements.get('rows').children[11].children[2].textContent,'40.00 MB');
  assert.equal(elements.get('total').textContent,'积累中');assert.equal(elements.get('main-total').textContent,'—');assert.equal(elements.get('main-label').textContent,'主卡月均');
  const yearSegments=elements.get('chart').children[11].children[0].children;
  assert.equal(yearSegments.length,2);assert.equal(yearSegments[0].style.background,'#0A94FF');
  elements.get('chart').children[0].onclick();assert.equal(elements.get('selected-main').textContent,'主卡 —');
  elements.clear();
  const averagedReports=api.statisticsReports(averageHistory,midnight);
  const averageHTML=api.statisticsHTML(averagedReports,false,'year');
  new vm.Script(averageHTML.match(/<script>([\s\S]*?)<\/script>/)[1]).runInNewContext({document:doc});
  assert.equal(elements.get('total').textContent,'150.00 MB');assert.equal(elements.get('main-total').textContent,'100.00 MB');assert.equal(elements.get('vice-total').textContent,'50.00 MB');
  assert.ok(elements.get('coverage').textContent.includes('2 个已结束月份'));assert.ok(elements.get('coverage').textContent.includes('1 个部分记录月'));
  assert.equal(elements.get('rows').children[11].children[5].textContent,'本月进行中');
  assert.equal(elements.get('rows').children[9].children[5].textContent,'部分记录');
  // 网页各视图保留两位：大 MB、小 MB 和 GB 不走组件默认精度。
  const fractionalReports=api.statisticsReports(cardCross,midnight);
  fractionalReports.month.days[2]={...fractionalReports.month.days[2],mb:954.53,mainMB:0.03,viceMB:954.5,unknownMB:0};
  let fractionalHTML=api.statisticsHTML(fractionalReports,false,'month');
  new vm.Script(fractionalHTML.match(/<script>([\s\S]*?)<\/script>/)[1]).runInNewContext({document:doc});
  elements.get('chart').children[2].onclick();
  assert.equal(elements.get('selected-total').textContent,'954.53 MB');assert.equal(elements.get('selected-main').textContent,'主卡 0.03 MB');
  fractionalReports.month.days[2].mb=10.39*1024;
  fractionalHTML=api.statisticsHTML(fractionalReports,false,'month');
  new vm.Script(fractionalHTML.match(/<script>([\s\S]*?)<\/script>/)[1]).runInNewContext({document:doc});
  elements.get('chart').children[2].onclick();assert.equal(elements.get('selected-total').textContent,'10.39 GB');
  fractionalReports.month.days[2].mb=0.001;
  fractionalHTML=api.statisticsHTML(fractionalReports,false,'month');
  new vm.Script(fractionalHTML.match(/<script>([\s\S]*?)<\/script>/)[1]).runInNewContext({document:doc});
  elements.get('chart').children[2].onclick();assert.equal(elements.get('selected-total').textContent,'<0.01 MB');
  const monthlyOutput='/private/tmp/unicom-monthly-preview';fs.mkdirSync(monthlyOutput,{recursive:true});
  fs.writeFileSync(monthlyOutput+'/browse.html',browsingHTML);
  const logHTML=api.statisticsHTML({...browseReports,refresh:queryReport});
  fs.writeFileSync(monthlyOutput+'/refresh-records.html',logHTML);
  elements.clear();new vm.Script(logHTML.match(/<script>([\s\S]*?)<\/script>/)[1]).runInNewContext({document:doc});
  assert.equal(elements.get('refresh-count').textContent,'2次');assert.equal(elements.get('refresh-average').textContent,'720分钟');
  assert.equal(elements.get('refresh-longest').textContent,'1320分钟');assert.equal(elements.get('refresh-rows').children.length,2);
  assert.equal(elements.get('refresh-empty').hidden,true);
  elements.clear();new vm.Script(api.statisticsHTML({...browseReports,refresh:{rows:[],count:0,average:null,longest:null}}).match(/<script>([\s\S]*?)<\/script>/)[1]).runInNewContext({document:doc});
  assert.equal(elements.get('refresh-empty').hidden,false);assert.equal(elements.get('refresh-average').textContent,'—');

  fs.writeFileSync(monthlyOutput+'/monthly.html',cardsHTML);fs.writeFileSync(monthlyOutput+'/yearly.html',averageHTML);
  api.applyTheme({theme:'白色'});fs.writeFileSync(monthlyOutput+'/monthly-light.html',api.statisticsHTML(reports,false,'month'));api.applyTheme({theme:'黑色'});
  fs.writeFileSync(monthlyOutput+'/hourly.html',api.statisticsHTML(api.statisticsReports(cardNext,at+2*3600000),false,'hours'));

  // 真正的原生绘图代码在 mock 中执行，将相同绘图指令输出为 SVG 供视觉检查。
  const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  class Color { constructor(hex) { this.hex = '#' + hex; } static white() { return new Color('FFFFFF'); } }
  class Rect { constructor(x,y,width,height) { Object.assign(this,{x,y,width,height}); } }
  class Size { constructor(width,height) { Object.assign(this,{width,height}); } }
  class Path { addRoundedRect(rect, rx, ry) { this.rect = rect; this.rx = rx; this.ry = ry; } }
  class DrawContext {
    constructor() { this.parts=[]; }
    setFillColor(c) { this.fill=c.hex; } setTextColor(c) { this.text=c.hex; }
    setFont(f) { this.font=f; } setTextAlignedLeft() {this.centered=false;this.right=false;} setTextAlignedCenter() {this.centered=true;this.right=false;} setTextAlignedRight() {this.centered=false;this.right=true;}
    fillRect(r) { this.parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${this.fill}"/>`); }
    addPath(p) { this.path=p; }
    fillPath() { const r=this.path.rect; this.parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${this.path.rx}" ry="${this.path.ry}" fill="${this.fill}"/>`); }
    drawTextInRect(t,r) { this.parts.push(`<text x="${this.right?r.x+r.width:this.centered?r.x+r.width/2:r.x}" y="${r.y+this.font.size}" text-anchor="${this.right?'end':this.centered?'middle':'start'}" fill="${this.text}" font-family="${this.font.name || (this.font.mono?'Menlo,monospace':'sans-serif')}" font-weight="${this.font.weight||400}" font-size="${this.font.size}">${esc(t)}</text>`); }
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
    from:new Date(new Date().setHours(hour,0,0,0)).getTime(), at:new Date(new Date().setHours(hour,30,0,0)).getTime(), mb:[30,85,40,260,240,280,150][i],mainMB:[30,85,40,260,240,280,150][i]*0.6,viceMB:[30,85,40,260,240,280,150][i]*0.4,unknownMB:0 }));
  for (const [name,medium,width,height] of [['small',false,158,158],['medium',true,338,158]]) {
    fs.writeFileSync(`${output}/${name}.svg`,visual.renderImage({history,stale:false},medium,width,height));
    fs.writeFileSync(`${output}/${name}-empty.svg`,visual.renderImage({history:{...history,events:[],data:{...base,categories:{general:base.categories.general,directed:null},at:visualAt}},stale:true},medium,width,height));
  }

  // 所有小时标签、竖线和柱子共用同一格的中心点，不再为 23 点单独偏移。
  const aligned=visual.renderImage({history,stale:false},true,338,158);
  assert.ok(aligned.includes('主 1.2GB')); assert.ok(aligned.includes('副 2.0GB'));
  const sharedSegments=[...aligned.matchAll(/<rect x="179" y="([0-9.]+)" width="5" height="([0-9.]+)" rx="[0-9.]+" ry="[0-9.]+" fill="#(?:0A94FF|8A73FF)"/g)];
  assert.equal(sharedSegments.length,2);
  const quotaRects=[...aligned.matchAll(/<rect x="[0-9.]+" y="[0-9.]+" width="5" height="([0-9.]+)" rx="([0-9.]+)" ry="([0-9.]+)"/g)];
  assert.ok(quotaRects.length>=5);
  for(const rect of quotaRects){assert.equal(rect[2],rect[3]);assert.ok(Math.abs(Number(rect[2])-Math.min(5,Number(rect[1]))/4)<1e-8);}
  assert.ok(Math.abs(Number(sharedSegments[0][2])-37*1.2/120)<1e-8);
  assert.ok(Math.abs(Number(sharedSegments[1][2])-37*2.02/120)<1e-8);
  assert.ok(Math.abs(Number(sharedSegments[0][1])+Number(sharedSegments[0][2])-67)<1e-8);
  assert.ok(Math.abs(Number(sharedSegments[1][1])+Number(sharedSegments[1][2])-Number(sharedSegments[0][1]))<1e-8);
  // 超额不超出轨道；零用量、不限量以及不完整的成员数据不绘制虚假进度。
  for (const [used,total,main,vice,colored] of [[150,120,50,100,true],[0,120,0,0,false],[12,null,4,8,false],[12,120,4,7,false]]) {
    const edgeData={...previewData,packages:previewData.packages.map(p=>p.shared?{...p,used,total,members:[{id:'a',role:'主卡',used:main},{id:'b',role:'副卡',used:vice}]}:p),members:[]};
    const edgeSvg=visual.renderImage({history:{...history,data:edgeData},stale:false},true,338,158);
    const bars=[...edgeSvg.matchAll(/<rect x="179" y="([0-9.]+)" width="5" height="([0-9.]+)" rx="[0-9.]+" ry="[0-9.]+" fill="#(?:0A94FF|8A73FF)"/g)];
    assert.equal(bars.length,colored?2:0);
    for(const bar of bars) { assert.ok(Number(bar[1])>=30-1e-8); assert.ok(Number(bar[1])+Number(bar[2])<=67+1e-8); }
  }

  const viceOnlyData={...previewData,at:visualAt,packages:previewData.packages.map(p=>p.shared?{...p,members:[{id:'a',role:'主卡',used:0},{id:'b',role:'副卡',used:p.used}]}:p),members:[]};
  const viceOnly=visual.renderImage({history:{...history,data:viceOnlyData},stale:false},true,338,158);
  assert.ok(/x="179" y="[0-9.]+" width="5" height="[0-9.]+" rx="[0-9.]+" ry="[0-9.]+" fill="#8A73FF"/.test(viceOnly));
  fs.writeFileSync(output+'/small-zero.svg',visual.renderImage({history:{...history,data:viceOnlyData},stale:false},false,158,158));
  fs.writeFileSync(output+'/medium-zero.svg',viceOnly);
  assert.ok(!viceOnly.includes('NaN'));assert.ok(!viceOnly.includes('主 0MB'));assert.ok(!viceOnly.includes('副 3.2GB'));
  const incompleteShared={...viceOnlyData,packages:viceOnlyData.packages.map(p=>p.shared?{...p,used:p.used+20}:p)};
  assert.ok(visual.renderImage({history:{...history,data:incompleteShared},stale:false},true,338,158).includes('主 0MB'));
  assert.ok(aligned.indexOf('主卡独享')<aligned.indexOf('共享流量'));
  assert.ok(visual.renderImage({history:{...history,data:incompleteShared},stale:false},true,338,158).includes('逐卡明细未补全'));
  assert.ok(aligned.includes('共享流量'));assert.ok(!aligned.includes('蓝主 / 紫副'));
  // 今日图例整组靠右，两行本身左对齐。
  const dailyLegends=[...aligned.matchAll(/<text x="([0-9.]+)" y="(88.5|96)" text-anchor="start"[^>]*>[主副]卡<\/text>/g)];
  assert.equal(dailyLegends.length,2);assert.equal(dailyLegends[0][1],dailyLegends[1][1]);
  assert.ok(Number(dailyLegends[0][1])>270);assert.equal(Number(dailyLegends[0][2]),88.5);assert.equal(Number(dailyLegends[1][2]),96);
  const footerTime=aligned.match(/<text [^>]*y="([0-9.]+)"[^>]*>更新 [^<]+<\/text>/);
  assert.ok(footerTime);assert.equal(Number(footerTime[1]),146.5);
  const alignedHours=visual.renderImage({history,stale:false},true,338,158,'today');
  const step=(338-26)/24;
  for(const hour of [0,6,12,18,23]) {
    const expected=13+(hour+0.5)*step;
    const tick=alignedHours.match(new RegExp('<text x="([0-9.]+)"[^>]*text-anchor="middle"[^>]*>'+String(hour).padStart(2,'0')+'</text>'));
    assert.ok(tick); assert.ok(Math.abs(Number(tick[1])-expected)<1e-8);
    assert.ok(alignedHours.includes(`x="${expected-0.25}" y="93"`));
  }

  // 过去小时灰色占位、真实零增量为紫色；当前无采样及未来小时不画柱。
  const fixedNoon=new Date(2026,10,4,12,30).getTime();
  class NoonDate extends Date {static now(){return fixedNoon;}}
  const noonVisual=await load.runInNewContext({UNICOM_FLOW_TEST:true,Date:NoonDate,Color,Rect,Size,Path,DrawContext,Font});
  // 月模式直接读既有每日汇总，小时明细清理后仍可显示；不把跨日总量塞进每日柱。
  const monthWidget=noonVisual.renderImage({history:{...cardCross,events:[]},stale:false},true,338,158,'month');
  assert.ok(monthWidget.includes('>每日用量</text>'));assert.ok(!monthWidget.includes('>小时用量</text>'));
  assert.ok(monthWidget.includes('>主卡</text>'));assert.ok(monthWidget.includes('>副卡</text>'));assert.ok(!monthWidget.includes('↻'));
  const day3x=13+(2+0.5)*(312/30), dayWidth=312/30-4.5;
  assert.ok(monthWidget.includes(`x="${day3x-dayWidth/2}" y="${128-29*60/90}" width="${dayWidth}" height="${29*60/90}" fill="#0A94FF"`));
  assert.ok(monthWidget.includes(`x="${day3x-dayWidth/2}" y="99" width="${dayWidth}" height="${29*30/90}" fill="#8A73FF"`));
  for(const day of [1,5,10,15,20,25,30]) {
    const match=monthWidget.match(new RegExp('<text x="([0-9.]+)" y="137"[^>]*>'+day+'</text>'));
    assert.ok(match);assert.ok(Math.abs(Number(match[1])-(13+(day-0.5)*312/30))<1e-8);
  }
  const monthZero=noonVisual.renderImage({history:zero,stale:false},true,338,158,'month');
  const zeroDay4x=13+3.5*(312/30)-dayWidth/2;
  assert.ok(monthZero.includes(`x="${zeroDay4x}" y="126.5" width="${dayWidth}" height="1.5" fill="#8A73FF"`));
  const futureDay5x=13+4.5*(312/30)-dayWidth/2;
  assert.ok(!monthZero.includes(`x="${futureDay5x}" y="126.5" width="${dayWidth}" height="1.5"`));
  for(const [time,count] of [[new Date(2026,11,3,12).getTime(),31],[new Date(2028,1,3,12).getTime(),29]]) {
    class CalendarDate extends Date {static now(){return time;}}
    const calendarVisual=await load.runInNewContext({UNICOM_FLOW_TEST:true,Date:CalendarDate,Color,Rect,Size,Path,DrawContext,Font});
    const image=calendarVisual.renderImage({history:zero,stale:false},true,338,158,'month');
    assert.equal([...image.matchAll(/width="0.5" height="35"/g)].length,count);assert.ok(image.includes('>'+count+'</text>'));
  }
  fs.writeFileSync(`${output}/medium-month-chart.svg`,monthWidget);
  const emptyHours={...history,data:{...history.data,at:fixedNoon},events:[]};
  const dayImage=noonVisual.renderImage({history:emptyHours,stale:false},true,338,158,'today');
  const hourlyBar=hour=>`x="${13+(hour+0.5)*13-4.25}" y="126.5" width="8.5" height="1.5"`;
  for(let hour=0;hour<12;hour++) assert.ok(dayImage.includes(hourlyBar(hour)+' fill="#454548"'));
  for(let hour=12;hour<24;hour++) assert.ok(!dayImage.includes(hourlyBar(hour)));
  const zeroHours={...emptyHours,events:[{from:new Date(2026,10,4,9,0).getTime(),at:new Date(2026,10,4,9,30).getTime(),mb:0}]};
  const zeroImage=noonVisual.renderImage({history:zeroHours,stale:false},true,338,158,'today');
  assert.ok(zeroImage.includes(hourlyBar(9)+' fill="#8A73FF"'));
  assert.ok(dayImage.includes('>小时用量</text>'));assert.ok(dayImage.includes('>主卡</text>'));assert.ok(dayImage.includes('>副卡</text>'));
  assert.ok(zeroImage.includes('>主卡</text>'));assert.ok(zeroImage.includes('>副卡</text>'));
  assert.ok(!zeroImage.includes('>未分</text>'));assert.ok(!zeroImage.includes('采样小时'));
  const unknownImage=noonVisual.renderImage({history:{...zeroHours,events:zeroHours.events.map(e=>({...e,mb:10,unknownMB:10}))},stale:false},true,338,158,'today');
  assert.ok(unknownImage.includes('>主卡</text>'));assert.ok(unknownImage.includes('>副卡</text>'));


  const cardAtNoon={...cardNext,events:[{...cardNext.events[0],from:new Date(2026,10,4,9).getTime(),at:new Date(2026,10,4,10).getTime()}]};
  const stackedWidget=noonVisual.renderImage({history:cardAtNoon,stale:false},true,338,158,'today');
  const reusableAtNoon={...reusable,data:{...reusable.data,at:fixedNoon},events:reusable.events.map(e=>({...e,from:new Date(2026,10,4,9).getTime(),at:new Date(2026,10,4,10).getTime()}))};
  for(const mode of ['month','today']) {
    const taller=noonVisual.renderImage({history:reusableAtNoon,stale:false},true,338,158,mode);
    assert.ok(taller.includes('y="93" width="0.5" height="35"'));
    assert.ok(taller.includes('y="82.5" text-anchor="start"') && taller.includes('y="90" text-anchor="start"'));
    assert.ok(taller.includes('y="137" text-anchor="middle"')); // 时间／日期刻度未下移
  }
  assert.ok(monthWidget.includes('y="99" width="0.5" height="29"')); // 有套餐逐卡明细时不压住文字
  for(const medium of [false,true]) {
    const todayImage=noonVisual.renderImage({history:reusableAtNoon,stale:false},medium,medium?338:158,158,'today');
    assert.ok(todayImage.includes('共享流量 · 今日'));assert.ok(todayImage.includes('主卡独享 · 今日'));
    assert.ok(todayImage.indexOf('主卡独享 · 今日')<todayImage.indexOf('共享流量 · 今日'));
    assert.ok(todayImage.includes('>30.0</text>'));assert.ok(todayImage.includes('>50.0</text>'));
    assert.ok(todayImage.includes('>0.22</text>'));assert.ok(todayImage.includes('>120</text>'));
    assert.ok(todayImage.includes('>0.34</text>'));assert.ok(todayImage.includes('>80</text>'));
    const totalRuns=[...todayImage.matchAll(/<text x="([0-9.]+)" y="(?:67|139)"[^>]*font-size="11">([^<]+)<\/text>/g)];
    assert.equal(totalRuns.slice(0,4).map(run=>run[2]).join('|'),'0.34|/|80|GB');
    const widths=[(3*0.60+0.28)*11,0.30*11,2*0.60*11];
    for(let index=0;index<3;index++) assert.ok(Math.abs(Number(totalRuns[index+1][1])-Number(totalRuns[index][1])-widths[index]-2)<1e-8);
    assert.ok(!/>[^<]*%[^<]*<\/text>/.test(todayImage));assert.ok(!todayImage.includes('本月'));
    assert.ok(todayImage.includes('今日已记录'));assert.ok(!todayImage.includes('主 60.0MB'));
    if(medium) {assert.ok(todayImage.includes('>主卡</text>'));assert.ok(todayImage.includes('>副卡</text>'));assert.ok(todayImage.includes('小时用量'));}
    const missingImage=noonVisual.renderImage({history:{...reusableAtNoon,events:[]},stale:false},medium,medium?338:158,158,'today');
    assert.ok(missingImage.includes('>—</text>'));assert.ok(!missingImage.includes('>0</text>'));assert.ok(missingImage.includes('今日待采样'));
    const zeroImage=noonVisual.renderImage({history:{...reusableAtNoon,events:reusableAtNoon.events.map(e=>({...e,mb:0,mainMB:0,viceMB:0,unknownMB:0}))},stale:false},medium,medium?338:158,158,'today');
    assert.ok(zeroImage.includes('>0</text>'));assert.ok(zeroImage.includes('今日已记录'));
    fs.writeFileSync(`${output}/${medium?'medium':'small'}-today.svg`,todayImage);
  }
  const zeroMainLegend=noonVisual.renderImage({history:{...cardAtNoon,events:cardAtNoon.events.map(e=>({...e,mb:30,mainMB:0,viceMB:30,unknownMB:0}))},stale:false},true,338,158);
  assert.ok(zeroMainLegend.includes('>主卡</text>')); // 已确认零用量不会留空
  const unevenWidget=noonVisual.renderImage({history:{...cardAtNoon,events:cardAtNoon.events.map(e=>({...e,mb:1030,mainMB:6,viceMB:1024,unknownMB:0}))},stale:false},true,338,158);
  const unevenLegends=[...unevenWidget.matchAll(/<text x="([0-9.]+)" y="(?:88.5|96)" text-anchor="start"[^>]*>[主副]卡<\/text>/g)];
  assert.equal(unevenLegends.length,2);assert.equal(unevenLegends[0][1],unevenLegends[1][1]);
  assert.ok(unevenWidget.includes('>主卡</text>'));assert.ok(unevenWidget.includes('>副卡</text>'));
  assert.ok(stackedWidget.includes('>主卡</text>'));assert.ok(stackedWidget.includes('>副卡</text>'));
  const hour10x=13+(10+0.5)*13-4.25;
  assert.ok(stackedWidget.includes(`x="${hour10x}" y="${128-35*60/90}" width="8.5" height="${35*60/90}" fill="#0A94FF"`));
  assert.ok(stackedWidget.includes(`x="${hour10x}" y="${128-35}" width="8.5" height="${35*30/90}" fill="#8A73FF"`));

  // 小号在不同手机尺寸下使用相同的安全留白，显示查询时间且不设刷新按钮。
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
    async loadJSON(){requestCount++; if(this.url.includes('/query/data/')) {if(apiError)throw new Error('offline');return {val:'JSESSIONID=FAKE_TEST_ONLY;'};}
      lastRequest={url:this.url,method:this.method,headers:this.headers,body:this.body};
      if(apiError)throw new Error('offline'); return dataPayload;}
  }
  const presented=[], feedback=[];
  let fontSizeInput='24';
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
    addTextField(){} textFieldValue(){return fontSizeInput;}
    addAction(){} addCancelAction(){}
    async presentSheet(){return this.presentAlert();}
    async presentAlert(){alerts.push({title:this.title,message:this.message});return alertChoices.length?alertChoices.shift():0;}
  }
  class MockDmYY {
    constructor() { this.settings={}; this.baseSettings={}; this.widgetFamily='medium'; this._menuActions=[]; }
    registerAction(item){this._menuActions.push(item);}
    saveSettings(){} reopenScript(){}
    async renderAppView(options, avatar, view){
      await view.loadHTML('<html><body><main>配置内容</main><div class="copyright"><div> </div><div>© 界面样式修改自 <a>@iMarkr.</a></div></div></body></html>');
      return {options,avatar,page:feedback.at(-1)};
    }
  }
  const dependency = { DmYY:MockDmYY, Runing:async Widget=>{
    const instance = new Widget('');
    environment.Script.setWidget(await instance.render()); environment.Script.complete();
  }};
  const environment = { UNICOM_FLOW_TEST:true, Timer:{schedule:(ms,repeat,callback)=>setTimeout(callback,0)}, config:{runsInWidget:true,runsInApp:false,widgetFamily:'medium'},
    args:{widgetParameter:'',queryParameters:{}}, importModule:name=>{assert.equal(name,'DmYY');return dependency;},
    FileManager, Request, ListWidget, Color, Rect, Size, Path, DrawContext, Alert, WebView, Data:{fromPNG:()=>({toBase64String:()=> 'FAKE_PREVIEW'})}, module:{filename:'/documents/联通流量.js'},
    Font:Object.assign(class extends Font {},Font,{boldSystemFont:size=>({size})}), Device:{screenSize:()=>({width:390,height:844})},
    Script:{name:()=> '联通流量',setWidget:w=>{widget=w;},complete:()=>{completed++;}} };
  // 四个独立脚本环境共用同一历史和短期请求锁，不重复查询联通。
  let cacheNow=new Date(2026,10,5,10).getTime(), cacheQueries=0, cookieChecks=0, cacheFailure=false, cacheCookie='JSESSIONID=CACHE_ACCOUNT_A;';
  class CacheDate extends Date {constructor(...args){super(...(args.length?args:[cacheNow]));}static now(){return cacheNow;}}
  class CacheRequest {
    constructor(url){this.url=url;}
    async loadJSON(){cookieChecks++;return {val:cacheCookie};}
    async loadString(){cacheQueries++;cacheNow++;if(cacheFailure)throw new Error('offline');return JSON.stringify(fixture());}
  }
  const sharedFiles=new Map();
  const cacheStore={read:(key,fallback)=>sharedFiles.has(key)?JSON.parse(sharedFiles.get(key)):fallback,write:(key,value)=>sharedFiles.set(key,JSON.stringify(value)),remove:key=>sharedFiles.delete(key),clear:()=>sharedFiles.delete('history')};
  const cacheApis=await Promise.all(Array.from({length:4},()=>load.runInNewContext({...environment,Date:CacheDate,Request:CacheRequest})));
  const together=await Promise.all(cacheApis.map(api=>api.refresh(cacheStore)));
  assert.equal(cacheQueries,1);assert.equal(cookieChecks,4);assert.equal(together.filter(r=>!r.fromCache).length,1);
  assert.equal(sharedFiles.has('query-lock'),false);
  const successAt=together[0].history.data.at, deadline=successAt+30*60000;
  cacheNow=successAt+20*60000;
  const twentyPast=await cacheApis[1].refresh(cacheStore);
  assert.equal(twentyPast.fromCache,true);assert.equal(cacheQueries,1);assert.equal(twentyPast.history.data.at,successAt);assert.equal(twentyPast.history.queryTimes.length,1);
  const cachedWidget=cacheApis[1].makeWidget(twentyPast,true);
  assert.equal(cachedWidget.refreshAfterDate.getTime(),deadline); // 10:20读取仍建议10:30，不能变10:50
  // 独立设置组件和请求间隔：缓存读取不改查询时间，按较早期限建议运行。
  const intervalApi=await load.runInNewContext({...environment,Date:CacheDate,Request:CacheRequest});
  const IntervalWidget=intervalApi.createWidgetClass(MockDmYY);
  const intervalInstance=new IntervalWidget('');
  assert.equal(intervalInstance.settings.refreshAfterDate,'30');
  assert.equal(intervalInstance.settings.dataRequestMinutes,'30');
  intervalInstance.settings.refreshAfterDate='10';intervalInstance.settings.dataRequestMinutes='40';intervalInstance.applySettings();
  assert.equal(intervalApi.queryDeadline(twentyPast.history),successAt+40*60000);
  assert.equal(intervalApi.makeWidget(twentyPast,true).refreshAfterDate.getTime(),cacheNow+10*60000);
  intervalInstance.settings.refreshAfterDate='30';intervalInstance.settings.dataRequestMinutes='25';intervalInstance.applySettings();
  assert.equal(intervalApi.makeWidget(twentyPast,true).refreshAfterDate.getTime(),successAt+25*60000);
  const stillCached=await intervalApi.refresh(cacheStore);assert.equal(stillCached.fromCache,true);
  assert.equal(stillCached.history.data.at,successAt);assert.equal(cacheQueries,1);
  intervalInstance.settings.refreshAfterDate='oops';intervalInstance.settings.dataRequestMinutes='0';intervalInstance.applySettings();
  assert.equal(intervalInstance.settings.refreshAfterDate,'30');assert.equal(intervalInstance.settings.dataRequestMinutes,'30');
  assert.equal(intervalApi.queryDeadline(twentyPast.history),deadline);
  assert.equal(intervalApi.makeWidget({...twentyPast,stale:true},true).refreshAfterDate.getTime(),cacheNow+5*60000);
  class LegacyIntervalDmYY extends MockDmYY {constructor(){super();this.settings.refreshAfterDate='45';}}
  const migratedInterval=new (intervalApi.createWidgetClass(LegacyIntervalDmYY))('');migratedInterval.applySettings();
  assert.equal(migratedInterval.settings.dataRequestMinutes,'45');
  assert.equal(intervalApi.queryDeadline(twentyPast.history),successAt+45*60000);
  const beforeManual=cacheQueries;
  const manual=await cacheApis[2].refresh(cacheStore,true);
  assert.equal(cacheQueries,beforeManual+1);assert.equal(manual.fromCache,false);assert.ok(manual.history.data.at>successAt);assert.equal(manual.history.queryTimes.length,2);
  cacheNow=cacheApis[0].queryDeadline(manual.history);
  await Promise.all(cacheApis.map(api=>api.refresh(cacheStore)));
  assert.equal(cacheQueries,beforeManual+2); // 到期四组件只再查一次
  const goodHistory=cacheStore.read('history');cacheFailure=true;
  await assert.rejects(cacheApis[0].refresh(cacheStore,true),/暂时不可用/);
  assert.equal(cacheStore.read('history').data.at,goodHistory.data.at);assert.deepEqual(cacheStore.read('history').queryTimes,goodHistory.queryTimes);assert.equal(sharedFiles.has('query-lock'),false);
  cacheFailure=false;cacheCookie='JSESSIONID=CACHE_ACCOUNT_B;';
  const changedAccount=await cacheApis[0].refresh(cacheStore);
  assert.notEqual(changedAccount.history.session,goodHistory.session);assert.equal(changedAccount.fromCache,false);assert.equal(changedAccount.history.queryTimes.length,1);
  cacheStore.write('query-lock',{owner:'expired',expiresAt:cacheNow-1});
  await cacheApis[0].refresh(cacheStore,true);assert.equal(sharedFiles.has('query-lock'),false);
  cacheNow=new Date(2026,10,5,23,50).getTime();
  const nearMidnight=await cacheApis[0].refresh(cacheStore,true);
  assert.equal(cacheApis[0].queryDeadline(nearMidnight.history),new Date(2026,10,6).getTime());
  const requestsBeforeMain=cacheQueries;let unwantedDmYY=0;
  const directApi=await load.runInNewContext({...environment,Date:CacheDate,Request:CacheRequest,FileManager:class extends FileManager {static local(){return new this();}fileExists(path){return path.endsWith('/history.json')||super.fileExists(path);}readString(path){return path.endsWith('/history.json')?JSON.stringify(nearMidnight.history):super.readString(path);}},importModule:()=>({DmYY:MockDmYY,Runing:async()=>{unwantedDmYY++;}})});
  await directApi.main();assert.equal(unwantedDmYY,0);assert.equal(cacheQueries,requestsBeforeMain);
  assert.equal(widget.refreshAfterDate.getTime(),new Date(2026,10,6).getTime());
  completed=0;
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
    assert.equal(widget.children.length,0);assert.ok(!widget.backgroundImage.includes('↻'));


  }
  const todayTapApi=await load.runInNewContext({...environment,config:{runsInApp:true,runsInWidget:false},args:{queryParameters:{ufRefresh:'1',ufFamily:'medium',ufMode:'today'}}});
  await todayTapApi.main();
  assert.ok(widget.backgroundImage.includes('今日'));
  assert.equal(widget.children.length,0);assert.equal(widget.url,undefined);
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
  assert.ok(!menus.some(item=>item.title==='显示方式' || item.val==='displayMode'));
  assert.ok(!menus.some(item=>item.name==='flowMembers' || item.title==='主副卡用量'));
  assert.equal(typeof instance.showMembers,'undefined');
  assert.deepEqual(instance._menuActions.map(group=>group.title),['预览组件','组件配置','用量与数据','维护']);
  assert.equal(menus.length,12);assert.equal(instance._menuActions[0].menu[0].name,'flowPreview');
  assert.equal(instance._menuActions[1].menu[0].name,'flowUpdate');
  assert.ok(!menus.some(item=>['套餐分类','账户说明','BoxJS 域名','连接检查','成员字段检查'].includes(item.title)));
  const beforeSubmenus=requestCount, advanced=await instance.advancedSettings();
  assert.deepEqual(Array.from(advanced.options[0].menu,item=>item.title),['账户说明','BoxJS 域名','套餐分类','连接检查','成员字段检查']);
  assert.equal(requestCount,beforeSubmenus); // 打开高级设置不查询账号
  const beforePreview=requestCount;
  await menus.find(item=>item.name==='flowPreview').onClick();assert.equal(requestCount,beforePreview+2);
  assert.ok(feedback.at(-1).presented);assert.ok(feedback.at(-1).html.includes('id="preview-small"'));
  assert.ok(feedback.at(-1).html.includes('id="preview-medium"'));assert.ok(feedback.at(-1).html.includes('data:image/png;base64,FAKE_PREVIEW'));
  const historyBeforePreview=files.get('/documents/UnicomFlow/history.json');
  const cachedPreviewRequests=requestCount;await instance.showPreview();assert.equal(requestCount,cachedPreviewRequests+1);
  assert.equal(files.get('/documents/UnicomFlow/history.json'),historyBeforePreview); // 再次预览只核对 Cookie，不重查联通
  const noPreview=new AppWidget('');noPreview.loadResult=async()=>{noPreview.result=null;noPreview.failure='请先连接 QX';};
  await noPreview.showPreview();assert.equal(alerts.at(-1).title,'组件预览');assert.equal(alerts.at(-1).message,'请先连接 QX');
  assert.ok(menus.some(item=>item.title==='用量统计'));
  assert.ok(!menus.some(item=>['本月用量','近12个月'].includes(item.title)));
  const immediate=menus.find(item=>item.name==='flowProxy');assert.equal(immediate.title,'立即刷新数据');
  const beforeImmediate=requestCount;await immediate.onClick();assert.equal(requestCount,beforeImmediate+2);
  assert.equal(alerts.at(-1).title,'刷新完成');
  const successfulBeforeFailure=files.get('/documents/UnicomFlow/history.json');
  apiError=true;await immediate.onClick();assert.equal(alerts.at(-1).title,'刷新未完成');
  assert.equal(files.get('/documents/UnicomFlow/history.json'),successfulBeforeFailure);apiError=false;
  const beforeStatistics=requestCount;await instance.showUsageStatistics();assert.equal(requestCount,beforeStatistics+1);
  assert.ok(feedback.at(-1).html.includes('tab-hours'));assert.ok(feedback.at(-1).html.includes('tab-year'));
  const recordMenu=menus.find(item=>item.name==='flowRefreshRecords');assert.equal(recordMenu.title,'刷新记录');
  await recordMenu.onClick();
  elements.clear();new vm.Script(feedback.at(-1).html.match(/<script>([\s\S]*?)<\/script>/)[1]).runInNewContext({document:doc});
  assert.equal(elements.get('page-title').textContent,'刷新记录');assert.equal(elements.get('usage-content').hidden,true);
  elements.get('refresh-records-toggle').onclick();assert.equal(elements.get('page-title').textContent,'用量统计');

  apiError=true;await instance.showUsageStatistics();assert.ok(feedback.at(-1).html.includes('缓存数据'));apiError=false;

  const configPage=await instance.renderAppView([{title:'预览组件',menu:[{name:'small'},{name:'medium'}]},...instance._menuActions]);
  assert.equal(configPage.options.flatMap(group=>group.menu).length,12);
  assert.equal(configPage.options.filter(group=>group.title==='预览组件').length,1);
  assert.equal(configPage.avatar,false);
  assert.ok(configPage.page.html.includes('配置内容'));
  assert.ok(!configPage.page.html.includes('界面样式修改自'));
  assert.ok(!configPage.page.html.includes('copyright'));
  assert.ok(!configPage.page.html.includes('@iMarkr'));
  const subPage=await instance.fontSettings();
  assert.ok(!subPage.page.html.includes('copyright'));
  const historyFile='/documents/UnicomFlow/history.json';
  const oldCached=JSON.parse(files.get(historyFile));delete oldCached.cardHistoryVersion;files.set(historyFile,JSON.stringify(oldCached));
  apiError=true;await instance.loadResult();assert.equal(instance.result,null);
  apiError=false;await instance.loadResult();assert.equal(instance.result.history.events.length,0);assert.equal(JSON.parse(files.get(historyFile)).cardHistoryVersion,1);
  const basic=await instance.refreshSettings();
  assert.equal(basic.options[0].title,'刷新设置');assert.equal(basic.options[0].menu.length,2);
  const widgetInterval=basic.options[0].menu.find(item=>item.val==='refreshAfterDate');
  const requestInterval=basic.options[0].menu.find(item=>item.val==='dataRequestMinutes');
  assert.equal(widgetInterval.title,'组件刷新间隔');assert.equal(requestInterval.title,'数据请求间隔');
  fontSizeInput='10';await widgetInterval.onClick();
  fontSizeInput='20';await requestInterval.onClick();instance.applySettings();
  assert.equal(instance.settings.refreshAfterDate,'10');assert.equal(instance.settings.dataRequestMinutes,'20');
  fontSizeInput='2';await requestInterval.onClick();assert.equal(instance.settings.dataRequestMinutes,'20');
  assert.equal(alerts.at(-1).title,'未保存');
  fontSizeInput='30';await widgetInterval.onClick();await requestInterval.onClick();instance.applySettings();
  fontSizeInput='24';
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
  const todayInstance=new AppWidget('today');
  assert.equal(todayInstance.flowMode,'today');
  assert.equal(new AppWidget('month').flowMode,'month');
  for(const family of ['small','medium']) {
    const w=family==='small'?await todayInstance.renderSmall():await todayInstance.renderMedium();
    assert.ok(w.backgroundImage.includes(' · 今日'));
  }
  const fontAction=instance._menuActions.flatMap(group=>group.menu).find(item=>item.name==='flowFonts');
  assert.ok(fontAction);
  const typography=await fontAction.onClick();
  assert.equal(typography.options.length,3);
  for(const [i,kind] of ['usage','total'].entries()) {
    const menu=typography.options[i].menu;
    assert.equal(menu[0].val,kind+'Font');
    assert.equal(menu[0].options.join(','),'系统 Regular,系统 Medium,SF Mono Regular,SF Mono Medium,Menlo Regular');
    assert.equal(menu[1].val,kind+'FontSize');
    assert.equal(menu[1].defaultValue,kind==='usage'?'25':'11');
  }
  const titleMenu=typography.options[2].menu[0];assert.equal(titleMenu.val,'titleFontSize');
  fontSizeInput='12';await titleMenu.onClick();assert.equal(instance.settings.titleFontSize,'12');
  for(const family of ['small','medium']) {
    const w=family==='small'?await instance.renderSmall():await instance.renderMedium();
    assert.match(w.backgroundImage,/font-size="12">数据流量·通用<\/text>/);
  }
  fontSizeInput='99';await titleMenu.onClick();assert.equal(instance.settings.titleFontSize,'12');assert.equal(alerts.at(-1).title,'未保存');
  fontSizeInput='';await titleMenu.onClick();assert.equal(instance.settings.titleFontSize,undefined);
  for(const family of ['small','medium']) {
    const w=family==='small'?await instance.renderSmall():await instance.renderMedium();
    assert.ok(w.backgroundImage.includes(`font-size="${family==='small'?10:11}">数据流量·通用</text>`));
  }
  assert.equal(instance.settings.usageFont,'SF Mono Medium');
  assert.equal(instance.settings.totalFont,'系统 Medium');
  for (const family of ['small','medium']) {
    const w=family==='small'?await instance.renderSmall():await instance.renderMedium();
    assert.match(w.backgroundImage, /y="51"[^>]*font-family="Menlo,monospace" font-weight="500" font-size="25">2.3<\/text>/);
    assert.match(w.backgroundImage, /y="67"[^>]*font-family="sans-serif" font-weight="500" font-size="11">27<\/text>/);
    const totals=[...w.backgroundImage.matchAll(/<text x="([0-9.]+)" y="([0-9.]+)"[^>]*font-family="sans-serif" font-weight="500" font-size="11">([^<]+)<\/text>/g)];
    const totalNumber=totals.find(row=>row[3]==='27'), totalUnit=totals.find(row=>row[3]==='GB(9%)');
    assert.ok(totalNumber && totalUnit);assert.equal(totalNumber[2],totalUnit[2]);
    assert.ok(Math.abs(Number(totalUnit[1])-Number(totalNumber[1])-2*11*0.60-2)<1e-8);
    const runs=[...w.backgroundImage.matchAll(/<text x="([0-9.]+)" y="([0-9.]+)"[^>]*font-family="Menlo,monospace" font-weight="500" font-size="([0-9.]+)">([^<]+)<\/text>/g)];
    const number=runs.find(row=>row[4]==='2.3'), unit=runs.find(row=>row[4]==='GB');
    assert.ok(number && unit);assert.equal(number[2],unit[2]);assert.equal(number[3],unit[3]);
    assert.ok(Math.abs(Number(unit[1])-Number(number[1])-3*25*0.62-2)<1e-8);

  }
  const presetInstance=settings=>{
    class PresetDmYY extends MockDmYY {constructor(arg){super(arg);this.settings={...settings};}}
    return new (appApi.createWidgetClass(PresetDmYY))('');
  };
  const obsoleteMode=presetInstance({displayMode:'主副卡分开显示'});
  assert.equal(Object.prototype.hasOwnProperty.call(obsoleteMode.settings,'displayMode'),false);
  const migratedDefault=presetInstance({usageFont:'SF Mono Regular',totalFont:'SF Mono Regular',usageFontSize:'22',totalFontSize:'10'});
  assert.equal(migratedDefault.settings.usageFont,'SF Mono Medium');assert.equal(migratedDefault.settings.totalFont,'系统 Medium');
  assert.equal(migratedDefault.settings.usageFontSize,'25');assert.equal(migratedDefault.settings.totalFontSize,'11');
  const custom={usageFont:'Menlo Regular',totalFont:'系统 Regular',usageFontSize:'23',totalFontSize:'12'};
  const preserved=presetInstance(custom);
  for(const key of Object.keys(custom)) assert.equal(preserved.settings[key],custom[key]);
  const once=presetInstance({usageFont:'SF Mono Regular',totalFont:'SF Mono Regular',usageFontSize:'22',totalFontSize:'10',mediumTypographyDefaultsApplied:true});
  assert.equal(once.settings.usageFont,'SF Mono Regular');assert.equal(once.settings.usageFontSize,'22');
  fontSizeInput='25.5';await typography.options[0].menu[1].onClick();
  assert.equal(instance.settings.usageFontSize,'25.5');
  for(const invalid of ['', 'abc', '29', '0']) {
    fontSizeInput=invalid;await typography.options[0].menu[1].onClick();
    assert.equal(instance.settings.usageFontSize,'25.5');assert.equal(alerts.at(-1).title,'未保存');
  }
  alertChoices.push(-1);fontSizeInput='20';await typography.options[0].menu[1].onClick();
  assert.equal(instance.settings.usageFontSize,'25.5');
  fontSizeInput='12.5';await typography.options[1].menu[1].onClick();
  assert.equal(instance.settings.totalFontSize,'12.5');
  instance.settings.usageFontSize='22';instance.settings.totalFontSize='10';
  for(const theme of ['黑色','白色']) {
    instance.settings.theme=theme;
    for(const [label,fontFamily,weight] of [['系统 Regular','sans-serif',400],['系统 Medium','sans-serif',500],['SF Mono Regular','Menlo,monospace',400],['SF Mono Medium','Menlo,monospace',500],['Menlo Regular','Menlo-Regular',400]]) {
      instance.settings.usageFont=label; instance.settings.totalFont=label;
      for(const family of ['small','medium']) {
        const fontWidget=family==='small'?await instance.renderSmall():await instance.renderMedium();
        const numericTexts=[...fontWidget.backgroundImage.matchAll(/<text[^>]*font-family="([^"]+)" font-weight="([0-9]+)"[^>]*>([^<]+)<\/text>/g)].filter(m=>m[1]===fontFamily && Number(m[2])===weight).map(m=>m[3]);
        assert.ok(numericTexts.includes('GB'));
        assert.ok(numericTexts.some(value=>value.includes('%')));
      }
    }
  }
  for(const [oldFont,expected] of [['SF Mono Semibold（半粗体）','SF Mono Regular'],['系统等宽','SF Mono Regular'],[undefined,null],['未知字体',null],['Menlo','Menlo Regular'],['Menlo Regular','Menlo Regular']]) {
    class LegacyFontDmYY extends MockDmYY {constructor(arg){super(arg);this.settings.numberFont=oldFont;}}
    const LegacyFontWidget=appApi.createWidgetClass(LegacyFontDmYY);
    const migratedFont=new LegacyFontWidget('');
    assert.equal(migratedFont.settings.usageFont,expected==='SF Mono Regular'||expected==null?'SF Mono Medium':expected);assert.equal(migratedFont.settings.totalFont,expected==='SF Mono Regular'||expected==null?'系统 Medium':expected);
  }
  unavailableFont=true; instance.settings.usageFont='Menlo Regular';instance.settings.totalFont='Menlo Regular';
  const fallbackFontWidget=await instance.renderSmall();
  assert.ok(fallbackFontWidget.backgroundImage.includes('font-family="Menlo,monospace" font-weight="400" font-size="22"'));
  unavailableFont=false;
  // 大小号共享字号，且用量与总量可独立混用字体、字重。
  instance.settings.usageFont='系统 Medium';instance.settings.totalFont='Menlo Regular';
  instance.settings.usageFontSize='24';instance.settings.totalFontSize='11.5';
  for(const family of ['small','medium']) {
    const w=family==='small'?await instance.renderSmall():await instance.renderMedium();
    assert.match(w.backgroundImage, /font-family="sans-serif" font-weight="500" font-size="24">2.3<\/text>/);
    assert.match(w.backgroundImage, /font-family="Menlo-Regular" font-weight="400" font-size="11.5">27<\/text>/);
    const rows=[...w.backgroundImage.matchAll(/<text x="([0-9.]+)"[^>]*>2.3<\/text>|<text x="([0-9.]+)"[^>]*>27<\/text>/g)];
    assert.equal(rows.length,2);assert.equal(rows[0][1],rows[1][2]);
  }
  // 过宽数字缩小后单位仍在卡片安全区；非法字号回退默认。
  instance.settings.usageFont='SF Mono Regular';instance.settings.totalFont='SF Mono Regular';
  instance.settings.usageFontSize='NaN';instance.settings.totalFontSize='999';
  const invalidSize=await instance.renderSmall();
  assert.ok(!invalidSize.backgroundImage.includes('NaN'));
  assert.match(invalidSize.backgroundImage,/font-size="25">2.3<\/text>/);
  assert.match(invalidSize.backgroundImage,/font-size="11">27<\/text>/);
  instance.settings.usageFontSize='22';instance.settings.totalFontSize='10';

  assert.ok(!JSON.stringify(instance.settings).includes('FAKE_TEST_ONLY'));
  files.delete('/documents/UnicomFlow/history.json'); dataPayload=cardFixture;
  await instance.loadResult();
  assert.ok(instance.result.history.data.members.some(m=>m.phone==='130****0002'));
  assert.ok(!Array.from(files.values()).join('').includes('13000000002'));
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
  failScriptWrite=true; // 内容相同即使禁止写入也应直接提示，无需替换文件。
  await instance.checkAndUpdateScript(); assert.equal(alerts.at(-1).title,'已是最新');
  assert.equal(files.get(path),source);assert.match(alerts.at(-1).message,/无需更新/);
  failScriptWrite=false;
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
  const actualPreview={month:{},today:{}};
  for(const mode of ['month','today'])for(const size of ['small','medium']){
    const svg=visual.renderImage({history,stale:false},size==='medium',size==='medium'?338:158,158,mode);
    actualPreview[mode][size]='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
  }
  fs.writeFileSync('/private/tmp/unicom-monthly-preview/combined-preview.html',api.previewHTML(actualPreview,{small:{width:158,height:158},medium:{width:338,height:158}}));
  console.log('PASS: 四组件共享缓存及并发合并/共同查询截止时间/手动强制查询/失败不改成功时间/跨日与账号隔离/绕过DmYY覆盖刷新时间、本月每日图/今日小时图/主副卡统一图例/移除刷新图标及链接/标题字号保存与恢复、默认单日今日/7日小时切换/12月每日切换/顶部汇总同步/日期边界/零与缺失/切换只读不持久化、month/today参数独立渲染及刷新保留模式/今日复用既有逐卡区间/删除冗余套餐字段/零区间不覆盖旧用量/归属不明确不猜测/零与缺失状态/GB精度阈值/图例空白状态区分、本月日聚合/跨日未分配/零与缺失/旧历史清空/逐卡堆叠与未知归属/12个月保留/逐卡明细列/已结束月份月均/本月合计口径一致/禁止双击缩放/Close顶部留白/小时与月度同页切换/日期交互/离线缓存、主副卡数据隔离/脱敏/缺失和冲突、抓包结构/镜像去重/角色标记/排除语音短信成员、请求主机与表单体/过期 Cookie 提示/表单失败回退、刻度居中/整卡背景、共享流量标题/零主卡图例隐藏/底部图例对齐/圆角安全留白/不同尺寸布局、无版本直接同步/校验/直接替换/本地与iCloud、黑白主题、共享/非共享分布、自动与手动分组、套餐解析、单位、重复共享包、缺失字段、分类、历史回退/跨月/跨日、会话隔离、乱序、原生绘图、首次运行/断网缓存、DmYY 分组菜单与尺寸预览、配置页不查询账号及 Cookie 不落盘。');
})();
