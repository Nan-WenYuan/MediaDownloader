import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FILES, REPOSITORY, sha256 } from '../../src/updater.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['pipe','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}}).trim();
function token(){if(process.env.GH_TOKEN||process.env.GITHUB_TOKEN)return process.env.GH_TOKEN||process.env.GITHUB_TOKEN;const result=execFileSync('git',['-c','credential.interactive=never','credential','fill'],{cwd:root,encoding:'utf8',input:'protocol=https\nhost=github.com\n\n',stdio:['pipe','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}});const line=result.split(/\r?\n/).find(l=>l.startsWith('password='));if(!line)throw Error('请先通过 Git Credential Manager 登录 GitHub');return line.slice(9);}
const credential=token();
async function request(url,options={},notFound=false){const u=new URL(url);if(u.protocol!=='https:'||!['api.github.com','uploads.github.com'].includes(u.hostname))throw Error('GitHub API 地址无效');const res=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(600000),headers:{Authorization:`Bearer ${credential}`,'User-Agent':'media-downloader-publisher','X-GitHub-Api-Version':'2022-11-28',...options.headers}});if(notFound&&res.status===404)return null;if(!res.ok)throw Error(`GitHub 请求失败 HTTP ${res.status}：${(await res.text()).slice(0,300)}`);return res.status===204?null:res.json();}
const json=(method,value)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
const base=`https://api.github.com/repos/${REPOSITORY}`;
async function main(){
  const profile=await request('https://api.github.com/user');if(profile.login!==REPOSITORY.split('/')[0])throw Error('GitHub 登录账号与仓库所有者不一致');
  if(process.argv.includes('--create-repo')){const existing=await request(base,{},true);if(existing){if(existing.private)throw Error('同名仓库已存在且非公开，未修改');console.log(`公开仓库已存在：${existing.html_url}`);return;}const repo=await request('https://api.github.com/user/repos',json('POST',{name:REPOSITORY.split('/')[1],description:'拾链接：Tauri + Vue 三平台便携媒体下载器（抖音、小红书、B站）',private:false,auto_init:false}));console.log(`已创建公开仓库：${repo.html_url}`);return;}
  if(git(['status','--porcelain']))throw Error('请先提交并推送源码，禁止发布与源码不一致的版本');
  const commit=git(['rev-parse','HEAD']),pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  await request(`${base}/commits/${commit}`);
  const remote=await request(`${base}/contents/package.json?ref=${commit}`);if(JSON.parse(Buffer.from(remote.content,'base64').toString()).version!==pkg.version)throw Error('远程版本与本地版本不一致');
  const folder=process.argv.find(a=>a.startsWith('--folder='))?.slice(9);if(!folder)throw Error('请指定 --folder=便携目录');const portable=path.resolve(root,folder);if(!portable.startsWith(path.join(root,'交付')+path.sep))throw Error('发布目录必须在本项目交付目录中');
  const prerelease=path.basename(portable).endsWith('_RC'),tag=`v${pkg.version}${prerelease?'-rc':''}`;
  if(await request(`${base}/releases/tags/${tag}`,{},true))throw Error('该版本已经发布，不会覆盖已有更新');
  const assets=[];for(let i=0;i<FILES.length;i++){const body=await fs.readFile(path.join(portable,FILES[i]));assets.push({path:FILES[i],asset:`media-${String(i+1).padStart(2,'0')}-${path.basename(FILES[i]).replace(/[^a-zA-Z0-9_.-]/g,'_')}`,size:body.length,sha256:sha256(body),body});}
  const history=await request(`${base}/releases?per_page=30`);
  const previous=history.find(r=>!r.draft&&r.assets.some(a=>a.name==='update-manifest.json'));
  let previousFiles=[];
  if(previous){const response=await fetch(previous.assets.find(a=>a.name==='update-manifest.json').browser_download_url);if(!response.ok)throw Error('上一版本清单读取失败');previousFiles=(await response.json()).files;}
  const uploads=[];
  const manifest={schema:1,version:pkg.version,files:assets.map(({body,...entry})=>{const old=previousFiles.find(f=>f.path===entry.path&&f.size===entry.size&&f.sha256===entry.sha256);const oldUrl=old&&(old.url||previous.assets.find(a=>a.name===old.asset)?.browser_download_url);if(oldUrl?.startsWith(`https://github.com/${REPOSITORY}/releases/download/`))return {...entry,url:oldUrl};uploads.push({name:entry.asset,body});return {...entry,url:`https://github.com/${REPOSITORY}/releases/download/${tag}/${entry.asset}`};})};
  const release=await request(`${base}/releases`,json('POST',{tag_name:tag,target_commitish:commit,name:`三平台下载器 ${pkg.version}${prerelease?' RC':''}`,draft:true,prerelease,body:`新增 GitHub Releases 在线更新，按文件 SHA-256 校验，更新只替换程序并保留登录状态、保存位置和下载文件。\n\n参考游戏存档管理器的便携更新流程；本程序包含下载后端，因此同步更新 EXE 与后端代码。\n\n源码：${commit}\n\n无压缩包：下载 download-portable.ps1 后在 PowerShell 运行，即可逐文件下载为完整便携目录。不要只下载单个 EXE。\n\nRC 限制：三平台登录全过程、抖音及小红书视频仍待真实链接验收。` }));
  const upload=release.upload_url.replace(/\{.*$/,'');
  for(const asset of [...uploads,{name:'download-portable.ps1',body:await fs.readFile(path.join(root,'项目资料/工具/download-portable.ps1'))},{name:'update-manifest.json',body:Buffer.from(JSON.stringify(manifest,null,2))}]){console.log(`上传 ${asset.name} (${asset.body.length} 字节)`);const result=await request(`${upload}?name=${encodeURIComponent(asset.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:asset.body});if(result.name!==asset.name)throw Error('GitHub 改写了文件名，发布保留为草稿');}
  const published=await request(`${base}/releases/${release.id}`,json('PATCH',{draft:false}));
  await fs.writeFile(path.join(root,'update-feed.json'),JSON.stringify({schema:1,manifestUrl:`https://github.com/${REPOSITORY}/releases/download/${tag}/update-manifest.json`,release:{tag_name:tag,html_url:published.html_url,body:published.body,prerelease}},null,2)+'\n');
  git(['add','update-feed.json']);git(['commit','-m',`chore: publish update feed ${tag}`]);git(['push']);console.log(`已发布：${published.html_url}`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
