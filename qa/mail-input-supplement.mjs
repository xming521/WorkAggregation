/** Production AppShell browser QA. All HTTP assets and /api are fulfilled locally.
 * No server, backend, mailbox, credential, provider, or model is contacted.
 */
import { chromium } from 'playwright-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createFixtureApi, retainedUserBody, retainedAiBody, sampleMail } from './fixture-api.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const dist=path.join(root,'dist');
const output=path.resolve(process.env.LOCALIZATION_EVIDENCE_DIR||path.join(root,'../../offerpilot-i18n-evidence'));
await mkdir(output,{recursive:true});
const origin='http://127.0.0.1:4174';
const report={kind:'strict synthetic production-web browser QA; not installed EXE QA',started_at:new Date().toISOString(),assertions:[],failures:[],screenshots:[],console:[],pageErrors:[],unexpectedNetwork:[],network:[],accessibility:[],chineseAudit:[],layout:[]};
const api=createFixtureApi({retainedConversation:true,configuredAi:true}); let browser,context,page,settings;
const allowedUserChinese=[retainedUserBody,retainedAiBody,sampleMail.evidence.snippet,'简体中文','用户原文保持不变 / user content stays unchanged','保留岗位 draft','保留邮件原文，2026-10-22 10:00 UTC 面试。','保留输入 draft'];
const check=(name,condition,detail)=>{assert(condition,detail||name);report.assertions.push(name);};
async function step(name,fn){console.log(`START ${name}`);try{await fn();console.log(`PASS ${name}`);}catch(error){report.failures.push({name,error:error.stack||String(error)});console.error(`FAIL ${name}: ${error.message}`);if(page&&!page.isClosed())await screenshot(`failure-${name}`).catch(()=>{});}}
async function auditDesktopText(name) {
 if(name.startsWith('dashboard-')) {
  const reasons=await page.locator('[class*="metricReason"]').evaluateAll(nodes=>nodes.map(node=>({
   text:node.textContent,
   clipped:node.scrollWidth>node.clientWidth+1||node.scrollHeight>node.clientHeight+1,
  })));
  check(`${name}: all six metric explanations render`,reasons.length===6,JSON.stringify(reasons));
  check(`${name}: metric explanations fit without clipping`,reasons.every(reason=>!reason.clipped),JSON.stringify(reasons));
 }
 if(name.startsWith('knowledge-')) {
  const search=await page.locator('.knowledge-sources-search').evaluate(group=>{
   const input=group.querySelector('input');const button=group.querySelector('button');
   if(!input||!button)return {missing:true};
   const style=getComputedStyle(input);const canvas=document.createElement('canvas');const context=canvas.getContext('2d');context.font=style.font;
   const inputRect=input.getBoundingClientRect();const buttonRect=button.getBoundingClientRect();
   return {placeholder:input.placeholder,
    textWidth:context.measureText(input.placeholder).width,
    available:input.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),
    centerDifference:Math.abs((inputRect.top+inputRect.bottom-buttonRect.top-buttonRect.bottom)/2),
    gap:buttonRect.left-inputRect.right};
  });
  check(`${name}: source search placeholder fits`,!search.missing&&search.textWidth<=search.available+1,JSON.stringify(search));
  check(`${name}: source Search stays beside its input`,!search.missing&&search.centerDifference<=2&&search.gap>=0&&search.gap<=24,JSON.stringify(search));
 }
}
async function screenshot(name){
 await auditDesktopText(name);
 const capture=async suffix=>{const file=path.join(output,`${suffix.replaceAll(/[^a-zA-Z0-9_-]/g,'-')}.png`);await page.screenshot({path:file,fullPage:true,animations:'disabled'});report.screenshots.push(file);};
 await capture(name);
 if(name.startsWith('board-')) {
  const board=page.locator('[data-kanban-board]');
  const before=await board.evaluate(el=>({left:el.scrollLeft,max:el.scrollWidth-el.clientWidth,overflow:getComputedStyle(el).overflowX}));
  if(name.endsWith('-1280'))check(`${name}: board provides horizontal scroll`,before.max>0&&['auto','scroll'].includes(before.overflow),JSON.stringify(before));
  if(before.max>0) {
   try {
    await board.evaluate(el=>{el.scrollLeft=el.scrollWidth;});await settle();
    const rightmost=await board.evaluate(el=>{const columns=el.querySelectorAll('[data-kanban-column-body]');const column=columns[columns.length-1]?.parentElement;const r=column?.getBoundingClientRect();const bounds=el.getBoundingClientRect();return {left:el.scrollLeft,max:el.scrollWidth-el.clientWidth,visible:!!r&&r.left>=bounds.left-1&&r.right<=bounds.right+1};});
    check(`${name}: rightmost board column reachable`,Math.abs(rightmost.left-rightmost.max)<=1&&rightmost.visible,JSON.stringify(rightmost));
    await capture(`${name}-rightmost`);
   } finally {await board.evaluate((el,left)=>{el.scrollLeft=left;},before.left);await settle();}
  }
 }
 // The desktop shell scrolls internally: fullPage alone only captures its first viewport.
 if(await page.getByRole('dialog').isVisible().catch(()=>false))return;
 const content=page.locator('.op-app-content');
 if(await content.count()!==1)return;
 const metrics=await content.evaluate(el=>({top:el.scrollTop,height:el.clientHeight,max:el.scrollHeight-el.clientHeight,scrollable:['auto','scroll'].includes(getComputedStyle(el).overflowY)}));
 if(!metrics.scrollable||metrics.max<=20||metrics.height<=0)return;
 try{let offset=0,index=0;while(offset<metrics.max){offset=Math.min(metrics.max,offset+Math.floor(metrics.height*0.8));await content.evaluate((el,y)=>{el.scrollTop=y;},offset);await settle();const label=`${name}-scroll-${++index}`;await capture(label);if(name.includes('-en-'))await audit(label);}}
 finally{await content.evaluate((el,y)=>{el.scrollTop=y;},metrics.top);await settle();}
}
async function settle(p=page){await p.locator('body').waitFor();await p.waitForTimeout(300);}
async function go(view){await page.goto(`${origin}/?view=${view}`);if(view==='pilot')await page.getByRole('button',{name:/^(退出沉浸模式，返回原页面|Exit immersive mode and return to the previous page)$/}).waitFor();else await page.getByText('OfferPilot',{exact:true}).first().waitFor();await settle();}
async function choose(locale){await settings.bringToFront();await settings.locator('section[aria-labelledby="language-settings-title"] .ant-select-selector').click();await settings.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:new RegExp(locale==='en-US'?'^English$':'^简体中文$')}).click();await settings.waitForFunction(expected=>document.documentElement.lang===expected,locale);await settle(settings);await page.bringToFront();await page.waitForFunction(expected=>document.documentElement.lang===expected,locale);await settle();}
const writeCount=()=>api.requests.filter(r=>r.method!=='GET').length;
async function audit(name){let text=await page.locator('body').innerText();for(const retained of allowedUserChinese)text=text.replaceAll(retained,'');const chinese=text.match(/[\u3400-\u9fff]+/g)||[];report.chineseAudit.push({name,unexpected:chinese});check(`${name}: no untranslated authored Chinese`,chinese.length===0,chinese.join(', '));const layout=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth,overflowingControls:[...document.querySelectorAll('button,input,textarea,.ant-select')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0&&(r.left< -2||r.right>innerWidth+2)}).map(e=>({text:e.textContent?.slice(0,120),label:e.getAttribute('aria-label'),rect:e.getBoundingClientRect().toJSON()}))}));report.layout.push({name,...layout});check(`${name}: no document horizontal overflow`,layout.document<=layout.viewport+2&&layout.body<=layout.viewport+2,JSON.stringify(layout));check(`${name}: visible controls remain on-screen`,layout.overflowingControls.length===0,JSON.stringify(layout.overflowingControls));const clippedLabels=await page.locator(name.startsWith('questions-') ? '.ant-select-selection-item' : '[data-kanban-card] .ant-select-selection-item, section[aria-label="Application list"] .ant-select-selection-item').evaluateAll(nodes=>nodes.filter(node=>node.clientWidth>0&&node.scrollWidth>node.clientWidth+1).map(node=>node.textContent));check(`${name}: application status and sort labels fit`,clippedLabels.length===0,JSON.stringify(clippedLabels));const clippedSearch=await page.locator('input[aria-label="Search conversations"], input[placeholder="Search questions / categories / tags"]').evaluateAll(nodes=>nodes.filter(node=>{const style=getComputedStyle(node);const canvas=document.createElement('canvas');const context=canvas.getContext('2d');context.font=style.font;return context.measureText(node.placeholder).width>node.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)+1;}).map(node=>node.placeholder));check(`${name}: search placeholders fit`,clippedSearch.length===0,JSON.stringify(clippedSearch));}
async function cancelModal(){await page.getByRole('dialog').getByRole('button',{name:/^(Cancel|取消)$/,exact:true}).click();await settle();}
try{
 const executablePath=process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
 browser=await chromium.launch({...(executablePath?{executablePath}:{}),headless:true,args:['--no-sandbox']});
 context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});
 await context.route('**/*',async route=>{
  const request=route.request();const url=new URL(request.url());report.network.push({method:request.method(),url:url.href});
  if(url.origin!==origin){report.unexpectedNetwork.push(url.href);return route.abort('blockedbyclient');}
  if(url.pathname.startsWith('/api/')){let body;try{body=request.postDataJSON()}catch{}const result=api.handle(request.method(),url.href,body);return route.fulfill({status:result.status,json:result.data});}
  if(request.method()!=='GET'){report.unexpectedNetwork.push(`${request.method()} ${url.href}`);return route.abort('blockedbyclient');}
  const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname).replace(/^\//,'');const filename=path.resolve(dist,relative);
  if(!filename.startsWith(dist+path.sep)){report.unexpectedNetwork.push(url.href);return route.abort();}
  try{const body=await readFile(filename);const ext=path.extname(filename);const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'}[ext]||'application/octet-stream';return route.fulfill({status:200,body,contentType:type,headers:{'Content-Security-Policy':"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:"}});}catch(error){report.unexpectedNetwork.push(`Missing fixture asset ${url.href}`);return route.fulfill({status:404,body:'Missing local fixture asset'});}
 });
 await context.routeWebSocket('**/*',ws=>{report.unexpectedNetwork.push(`WebSocket ${ws.url()}`);ws.close();});
 context.on('page',p=>{p.on('console',m=>{if(m.type()==='error'||m.type()==='warning')report.console.push({type:m.type(),text:m.text()});});p.on('pageerror',e=>report.pageErrors.push(e.message));p.setDefaultTimeout(8000);});
 page=await context.newPage();settings=await context.newPage();
 await settings.goto(`${origin}/?view=settings`);await settings.getByRole('combobox',{name:'界面语言'}).waitFor();await go('settings');

 report.source_sha='db9d8536845fbe2d7cee93b0d0b029185525277a';
 report.harness_sha=process.env.GITHUB_SHA;
 report.run_url='https://github.com/'+process.env.GITHUB_REPOSITORY+'/actions/runs/'+process.env.GITHUB_RUN_ID;
 report.kind='single-state supplemental synthetic production-web screenshot; not full QA or installed EXE';
 await choose('en-US');
 const writesBefore=writeCount();
 await page.getByRole('button',{name:'Paste one email',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await dialog.waitFor({state:'visible'});
 await page.getByLabel('Email subject',{exact:true}).fill('Interview invitation');
 await page.getByLabel('Sender address (manually supplied, unverified)',{exact:true}).fill('recruiter@example.invalid');
 await page.getByLabel('Actual received time (with timezone)',{exact:true}).fill('2026-10-15T07:00:00Z');
 await page.getByLabel('Email body',{exact:true}).fill('保留邮件原文，2026-10-22 10:00 UTC 面试。');
 const controls=[
  page.getByLabel('Email subject',{exact:true}),
  page.getByLabel('Sender address (manually supplied, unverified)',{exact:true}),
  page.getByLabel('Actual received time (with timezone)',{exact:true}),
  page.getByLabel('Email body',{exact:true}),
  dialog.getByRole('button',{name:'Preview text to submit',exact:true}),
  dialog.getByRole('button',{name:'Cancel',exact:true}),
 ];
 for(const control of controls)await control.waitFor({state:'visible'});
 check('dialog and all four inputs plus both footer controls visible',await dialog.isVisible()&&(await Promise.all(controls.map(c=>c.isVisible()))).every(Boolean));
 await page.waitForFunction(()=>{
  const dialog=document.querySelector('[role="dialog"]');if(!dialog)return false;
  for(let node=dialog;node;node=node.parentElement){
   const style=getComputedStyle(node);
   if(style.visibility!=='visible'||style.display==='none'||Number(style.opacity)!==1)return false;
  }
  return !dialog.getAnimations({subtree:true}).some(a=>['running','pending'].includes(a.playState)&&a.effect?.getTiming().iterations!==Infinity);
 },null,{timeout:10000});
 check('dialog ancestors opacity 1 and finite animations settled',true);
 report.paint=await dialog.evaluate(async dialog=>{
  const read=()=>({rect:dialog.getBoundingClientRect().toJSON(),opacity:getComputedStyle(dialog).opacity,transform:getComputedStyle(dialog).transform});
  const before=read();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const after=read();
  return {before,after,stable:JSON.stringify(before)===JSON.stringify(after)};
 });
 check('dialog geometry opacity and transform stable across two animation frames',report.paint.stable,JSON.stringify(report.paint));
 await audit('mail-import-supplement-en-1440');
 check('input content preserved',await page.getByLabel('Email body',{exact:true}).inputValue()==='保留邮件原文，2026-10-22 10:00 UTC 面试。');
 check('single-state flow performs no writes',writeCount()===writesBefore&&writeCount()===0);
 check('all API requests explicitly mocked',api.unexpected.length===0);
 check('no unexpected outbound network',report.unexpectedNetwork.length===0);
 check('no uncaught runtime errors',report.pageErrors.length===0);
 check('no model or provider requests',!api.requests.some(r=>r.method!=='GET'));
 const file=path.join(output,'mail-import-en-1440-supplement-db9d8536.png');
 await page.screenshot({path:file,fullPage:true,animations:'allow'});
 report.screenshots.push(file);
 check('exactly one supplemental screenshot',report.screenshots.length===1);
}catch(error){report.failures.push({name:'browser/setup',error:error.stack||String(error)});console.error(error.message);}finally{report.finished_at=new Date().toISOString();report.apiRequests=api.requests;report.unmockedApi=api.unexpected;report.status=report.failures.length?'failed':'passed';await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser?.close();console.log(`REPORT ${path.join(output,'report.json')}`);if(report.failures.length)process.exitCode=1;}
