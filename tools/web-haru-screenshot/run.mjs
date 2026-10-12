import { chromium } from 'playwright-core';
import { createServer } from '../../web/node_modules/vite/dist/node/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve('tools/web-haru-screenshot/evidence'); await fs.mkdir(out,{recursive:true});
const server=await createServer({root:path.resolve('web'),server:{host:'127.0.0.1',port:5178,strictPort:true}}); await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true});
const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
const logs=[]; page.on('pageerror',e=>logs.push({error:e.message}));
page.on('console',m=>{if(m.type()==='error')logs.push({console:m.text()})});
const api=[];
await page.route('**/api/**',route=>{
 const p=new URL(route.request().url()).pathname; api.push({path:p,method:route.request().method()});
 if(route.request().method()!=='GET')return route.fulfill({status:403,body:'Synthetic screenshot: writes disabled'});
 let data=[];
 if(p==='/api/auth/status')data={auth_enabled:false,authenticated:true};
 if(p==='/api/settings')data={version:'0.1.0',data_dir:'',chat_auto_approve_writes:false,active_provider_id:'',fallback_provider_ids:[],providers:[],base_url:'',model:'',has_api_key:false,runtime_mode:'local',auth_enabled:false,has_auth_token:false,log_level:'INFO'};
 if(p==='/api/dashboard')data={total:0,board:{pending:[],applied:[],written_test:[],interview:[],offer:[],closed:[]}};
 if(p==='/api/onboarding')data={steps:{configure_ai:true,create_primary_resume:true,create_first_application:true,send_first_pilot_message:true},completed_count:4,is_complete:true,force_open:false};
 if(p.includes('/proactive/'))data={items:[],jobs:[],total:0};
 if(p==='/api/questions/stats')data={total:0,due:0,mastered:0,reviewed_today:0,by_topic:[]};
 return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
});
await page.route(/^https?:\/\/(?!127\.0\.0\.1:5178)/,route=>route.abort());
try{
 await page.goto('http://127.0.0.1:5178/?view=board',{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'打开 OfferPilot 领航员',exact:true}).waitFor({timeout:30000});
 await page.getByRole('button',{name:'打开 OfferPilot 领航员',exact:true}).click();
 await page.getByRole('dialog',{name:'Haru 轻量对话'}).waitFor();
 await page.waitForTimeout(2000);
 if(await page.getByText('Haru 暂时休息中',{exact:true}).count())throw Error('Haru Live2D model failed to render');
 await page.screenshot({path:path.join(out,'haru-web-master-full.png'),fullPage:false});
 const dialog=await page.getByRole('dialog',{name:'Haru 轻量对话'}).boundingBox();
 const mascot=await page.getByLabel('Haru 助手',{exact:true}).boundingBox();
 const x=Math.max(0,Math.min(dialog.x,mascot.x)-16),y=Math.max(0,Math.min(dialog.y,mascot.y)-16);
 const right=Math.min(1440,Math.max(dialog.x+dialog.width,mascot.x+mascot.width)+16),bottom=Math.min(1000,Math.max(dialog.y+dialog.height,mascot.y+mascot.height)+16);
 await page.screenshot({path:path.join(out,'haru-web-master-detail.png'),clip:{x,y,width:right-x,height:bottom-y}});
 await fs.writeFile(path.join(out,'metadata.json'),JSON.stringify({sourceCommit:'5b9605bab343c4f95ede2c0c61ecd47bb7d923a1',viewport:{width:1440,height:1000},scenario:'Actual current master React web app; empty synthetic workspace; AI unconfigured; Haru dialog opened with original Live2D model; no product code changes',dialog,mascot,api,logs},null,2));
}catch(e){await page.screenshot({path:path.join(out,'failure.png')});await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({message:String(e),body:await page.locator('body').innerText(),api,logs},null,2));throw e;}
finally{await browser.close();await server.close();}
