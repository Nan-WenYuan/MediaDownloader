import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'Nan-WenYuan/MediaDownloader';
export const FILES = ['三平台下载器.exe','使用说明.txt','runtime/node.exe','runtime/ffmpeg.exe','runtime/Node-LICENSE.txt','runtime/FFmpeg-LICENSE.txt', ...['desktop-worker.mjs','core.mjs','auth.mjs','downloader.mjs','updater.mjs','platforms/bilibili.mjs','platforms/douyin.mjs','platforms/xiaohongshu.mjs'].map(f=>'backend/'+f)];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function newer(candidate,current) {
  if(!/^\d+\.\d+\.\d+$/.test(candidate)||!/^\d+\.\d+\.\d+$/.test(current))throw Error('更新版本号无效');
  const a=candidate.split('.').map(Number),b=current.split('.').map(Number);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return false;
}
export function validateManifest(value) {
  if(value?.schema!==1||!/^\d+\.\d+\.\d+$/.test(value.version)||!Array.isArray(value.files)||value.files.length!==FILES.length)throw Error('更新清单格式无效');
  const names=new Set(),assets=new Set();
  for(const f of value.files){
    if(!FILES.includes(f.path)||names.has(f.path)||!/^media-[a-zA-Z0-9_.-]+$/.test(f.asset)||assets.has(f.asset)||!Number.isSafeInteger(f.size)||f.size<1||f.size>512*1024*1024||!/^\w{64}$/.test(f.sha256)||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('更新清单包含非法路径、重复文件或无效校验值');
    names.add(f.path);assets.add(f.asset);
    if(f.url){trusted(f.url);if(!f.url.startsWith(`https://github.com/${REPOSITORY}/releases/download/`))throw Error('文件来源不是本项目发布');}
  }
  return value;
}
function trusted(url){const u=new URL(url);if(u.protocol!=='https:'||!(u.hostname==='api.github.com'||u.hostname==='github.com'||u.hostname.endsWith('.githubusercontent.com')))throw Error('更新地址不是受信任的 GitHub 地址');return u;}
async function request(url,limit) {
  for(let redirects=0;redirects<6;redirects++){
    trusted(url);const response=await fetch(url,{redirect:'manual',headers:{'User-Agent':'media-downloader-updater','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(180000)});
    if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');await response.body?.cancel();if(!next)throw Error('更新重定向无效');url=new URL(next,url).href;continue;}
    if(!response.ok)throw Error(response.status===404?'尚未发布可用的更新版本':`GitHub 更新请求失败：HTTP ${response.status}`);
    if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('更新文件超出大小限制');}
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit){throw Error('更新文件超出大小限制');}chunks.push(chunk);}return Buffer.concat(chunks);
  }throw Error('更新重定向次数过多');
}
async function latest(){
  // 静态源避开 GitHub 匿名 API 限流；RC 也可试用，无需登录凭据。
  const feed=JSON.parse((await request(`https://raw.githubusercontent.com/${REPOSITORY}/main/update-feed.json`,128*1024)).toString());
  if(feed.schema!==1||!feed.manifestUrl?.startsWith(`https://github.com/${REPOSITORY}/releases/download/`))throw Error('更新源格式无效');
  const release=feed.release;
  const manifest=validateManifest(JSON.parse((await request(feed.manifestUrl,128*1024)).toString()));
  if(![ `v${manifest.version}`,`v${manifest.version}-rc`].includes(release.tag_name))throw Error('发布标签与更新清单不一致');
  for(const f of manifest.files)if(!f.url)throw Error('更新清单缺少文件地址');
  return {release,manifest};
}
export async function checkUpdate(version){const {release,manifest}=await latest();return {currentVersion:version,latestVersion:manifest.version,available:newer(manifest.version,version),releaseUrl:release.html_url,notes:release.body||'',prerelease:release.prerelease};}
export async function prepareUpdate(root,version) {
  if(!await fs.stat(path.join(root,'runtime/node.exe')).catch(()=>null))throw Error('请使用便携版进行更新，开发环境不替换源码');
  const {release,manifest}=await latest();if(!newer(manifest.version,version))throw Error('已经是最新版本');
  const directory=path.join(root,'.media-update',randomUUID());await fs.mkdir(path.join(directory,'staged'),{recursive:true});
  try{
    const changed=[];
    for(const f of manifest.files){
      const current=await fs.readFile(path.join(root,f.path)).catch(()=>null);if(current&&sha256(current)===f.sha256)continue;
      const bytes=await request(f.url,f.size);
      if(bytes.length!==f.size||sha256(bytes)!==f.sha256)throw Error(`更新文件校验失败：${f.path}`);
      const target=path.join(directory,'staged',f.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);changed.push(f);
    }
    await fs.copyFile(process.execPath,path.join(directory,'helper.exe'));
    await fs.copyFile(fileURLToPath(import.meta.url),path.join(directory,'helper.mjs'));
    await fs.writeFile(path.join(directory,'handoff.json'),JSON.stringify({manifest,changed,workerPid:process.pid}));
    return {directory,files:changed.length,version:manifest.version};
  }catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitPid(pid){if(!Number.isSafeInteger(pid)||pid<=0)throw Error('更新进程编号无效');for(let i=0;i<240;i++){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return;throw e;}await delay(250);}throw Error('程序未正常退出，未替换任何文件');}
async function assertRegularPath(root,relative){let current=root;for(const part of relative.split('/')){current=path.join(current,part);const stat=await fs.lstat(current).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(stat?.isSymbolicLink())throw Error('更新路径包含符号链接，已拒绝替换');}}
export async function applyFiles(root,directory,manifest,changed) {
  validateManifest(manifest);
  if(!Array.isArray(changed)||new Set(changed.map(f=>f.path)).size!==changed.length)throw Error('更新交接文件无效');
  for(const f of changed){const original=manifest.files.find(a=>a.path===f.path);if(JSON.stringify(original)!==JSON.stringify(f))throw Error('交接清单被修改');await assertRegularPath(root,f.path);await assertRegularPath(directory,'staged/'+f.path);const bytes=await fs.readFile(path.join(directory,'staged',f.path));if(bytes.length!==f.size||sha256(bytes)!==f.sha256)throw Error('安装前校验失败');}
  const installed=[];
  try{
    for(const f of changed){const destination=path.join(root,f.path),backup=path.join(directory,'backup',f.path);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.mkdir(path.dirname(backup),{recursive:true});const existed=await fs.stat(destination).catch(()=>null);if(existed)await fs.rename(destination,backup);installed.push({destination,backup,existed:!!existed});await fs.copyFile(path.join(directory,'staged',f.path),destination);}
  }catch(error){await rollbackFiles(installed);throw error;}
  return installed;
}
export async function rollbackFiles(installed){for(const f of [...installed].reverse()){await fs.rm(f.destination,{force:true});if(f.existed)await fs.rename(f.backup,f.destination);}}
async function applyHelper(){
  const directory=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(path.dirname(directory));
  if(path.basename(path.dirname(directory))!=='.media-update'||path.basename(process.execPath)!=='helper.exe')throw Error('更新助手路径无效');
  const handoff=JSON.parse(await fs.readFile(path.join(directory,'handoff.json'),'utf8'));
  await waitPid(Number(process.argv[3]));await waitPid(handoff.workerPid);
  let installed=[];
  try {
  installed=await applyFiles(root,directory,handoff.manifest,handoff.changed);
  // 在启动 GUI 前验证更新后的 Node 服务能启动；失败则恢复所有已替换文件。
  try{
    await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'三平台下载器.exe'),['--self-test'],{cwd:root,windowsHide:true,stdio:'ignore'});const timeout=setTimeout(()=>{child.kill();reject(Error('新版启动预检超时'));},60000);child.once('error',e=>{clearTimeout(timeout);reject(e);});child.once('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('新版启动预检失败'));});});
  }catch(e){throw e;}
  const child=spawn(path.join(root,'三平台下载器.exe'),[],{cwd:root,detached:true,windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  await fs.writeFile(path.join(directory,'completed'),'ok');
  } catch(error) {
    await rollbackFiles(installed);
    await fs.writeFile(path.join(directory,'failed.txt'),error.message);
    const original=spawn(path.join(root,'三平台下载器.exe'),[],{cwd:root,detached:true,windowsHide:true,stdio:'ignore'});
    original.on('error',()=>{});original.unref();throw error;
  }
}
if(process.argv[2]==='--apply-update')applyHelper().catch(async error=>{await fs.writeFile(path.join(path.dirname(fileURLToPath(import.meta.url)),'failed.txt'),error.message).catch(()=>{});process.exitCode=1;});
