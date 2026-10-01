import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getCookieHeader, loginUrl, startAuthBrowser, closeAuthBrowser } from './auth.mjs';
import { extractUrls, detectPlatform } from './core.mjs';
import { resolveDouyin, downloadDouyin } from './platforms/douyin.mjs';
import { resolveXiaohongshu, downloadXiaohongshu } from './platforms/xiaohongshu.mjs';
import { resolveBilibili, downloadBilibili } from './platforms/bilibili.mjs';
import { checkUpdate, prepareUpdate } from './updater.mjs';
const root = process.env.MEDIA_APP_DIR || process.cwd();
const dataDir = process.env.MEDIA_DATA_DIR || path.join(root, '.runtime', 'desktop');
const configPath = path.join(dataDir, 'settings.json');
const adapters = { douyin: [resolveDouyin, downloadDouyin], xiaohongshu: [resolveXiaohongshu, downloadXiaohongshu], bilibili: [resolveBilibili, downloadBilibili] };
const state = { version: process.env.MEDIA_VERSION || '0.3.1', busy: false, output: path.join(root,'下载结果'), jobs: [], accounts: {douyin:'未检查',xiaohongshu:'未检查',bilibili:'未检查'} };
try { const settings = JSON.parse(await fs.readFile(configPath,'utf8')); if (typeof settings.output === 'string' && path.isAbsolute(settings.output)) state.output = settings.output; } catch {}
async function save() { await fs.mkdir(dataDir,{recursive:true}); await fs.writeFile(configPath,JSON.stringify({output:state.output},null,2)); }
async function queue(jobs) {
  try {
    for (const job of jobs) {
      try {
        job.status='解析中'; job.error='';
        const cookie=await getCookieHeader(loginUrl(job.platform));
        const task=await adapters[job.platform][0](job.url,{cookie});
        job.title=task.title; job.quality=task.quality; job.status='下载中';
        const files=await adapters[job.platform][1](task,state.output, progress=>{
          job.progress=progress.text; job.percent=progress.total?Math.min(100,Math.round(progress.received/progress.total*100)):0;
          if(progress.role==='merge')job.status='合并中';
        });
        job.status='已完成'; job.percent=100; job.files=files.map(f=>f.destination); job.progress=`${files.length} 个文件已保存`;
      } catch(error){ job.status='失败'; job.error=error.message; }
    }
  } finally { state.busy=false; }
}
async function execute(command,args) {
  if(command==='state')return state;
  if(command==='shutdown'){ await closeAuthBrowser(); return true; }
  if(command==='account') {
    const platform=args.platform;if(!adapters[platform])throw Error('未知平台');
    const cookie=await getCookieHeader(loginUrl(platform),{startIfProfileExists:false});
    const marker={bilibili:'SESSDATA',xiaohongshu:'web_session',douyin:'sessionid'}[platform];
    state.accounts[platform]=cookie.split('; ').some(item=>item.startsWith(marker+'='))?'存在账号会话':'未检测到账号会话';
    return state;
  }
  if(command==='open_folder'){
    await fs.mkdir(state.output,{recursive:true});
    await new Promise((resolve,reject)=>{const child=spawn('explorer.exe',[state.output],{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});return true;
  }
  if(state.busy)throw Error('请等待当前下载完成');
  if(command==='update_check')return checkUpdate(state.version);
  if(command==='update_prepare')return prepareUpdate(root,state.version);
  if(command==='set_output'){
    const candidate=String(args.output||'').trim();if(!path.isAbsolute(candidate))throw Error('请选择完整的保存目录');
    await fs.mkdir(candidate,{recursive:true});const previous=state.output;state.output=candidate;try{await save();}catch(error){state.output=previous;throw error;}return state;
  }
  if(command==='login'){
    if(!adapters[args.platform])throw Error('未知平台');
    await startAuthBrowser({interactive:true,platform:args.platform});return {message:'请在专用 Edge 窗口登录，完成后回到客户端点击“检查登录”。'};
  }
  if(command==='download'||command==='retry'){
    const urls=command==='retry'?state.jobs.filter(j=>j.status==='失败').map(j=>j.url):extractUrls(args.text||'');
    if(!urls.length)throw Error(command==='retry'?'没有失败任务':'请粘贴至少一条分享链接');
    if(urls.some(url=>!adapters[detectPlatform(url)]))throw Error('仅支持抖音、小红书、B站分享链接');
    await fs.mkdir(state.output,{recursive:true});await save();
    state.jobs=urls.map((url,id)=>({id,url,platform:detectPlatform(url),title:'等待解析',status:'排队中',percent:0}));state.busy=true;
    void queue(state.jobs);return state;
  }
  throw Error('未知操作');
}
const reader=createInterface({input:process.stdin,terminal:false});
for await(const line of reader){
  try{const {command,args={}}=JSON.parse(line);const result=await execute(command,args);process.stdout.write(JSON.stringify({result})+'\n');if(command==='shutdown')break;}
  catch(error){process.stdout.write(JSON.stringify({error:error.message})+'\n');}
}
await closeAuthBrowser();
process.exit(0);
