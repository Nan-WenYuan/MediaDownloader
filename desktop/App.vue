<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { Download, FolderOpen, Folder, Link, RefreshCw, Check, AlertCircle, LogIn, ArrowDownToLine, Video, Image, LoaderCircle } from 'lucide-vue-next';
const state=ref({version:'0.3.1',output:'',busy:false,jobs:[],accounts:{}}), text=ref(''), message=ref(''), error=ref(false), working=ref(false), page=ref('download'), update=ref(null);
const platforms=[{id:'douyin',name:'抖音',short:'抖',color:'#ef466f'},{id:'xiaohongshu',name:'小红书',short:'红',color:'#e34646'},{id:'bilibili',name:'B站',short:'B',color:'#329fc7'}];
const done=computed(()=>state.value.jobs.filter(j=>j.status==='已完成').length);
const failures=computed(()=>state.value.jobs.filter(j=>j.status==='失败').length);
let timer, polling=false;
function notify(value,failed=false){message.value=value;error.value=failed;}
async function rpc(command,args={}){return invoke('service',{command,args});}
async function refresh(){if(polling||working.value)return;polling=true;try{state.value=await rpc('state');}catch(e){notify(String(e),true);}finally{polling=false;}}
async function act(action){working.value=true;try{await action();}catch(e){notify(String(e),true);}finally{working.value=false;await refresh();}}
function download(){act(async()=>{await rpc('download',{text:text.value});notify('任务已加入队列，文件将按顺序下载。');});}
function choose(){act(async()=>{const output=await invoke('choose_folder',{current:state.value.output});if(output){state.value=await rpc('set_output',{output});notify('保存位置已更新，下次启动继续使用。');}});}
function login(platform){act(async()=>{const result=await rpc('login',{platform});notify(result.message);});}
function account(platform){act(async()=>{state.value=await rpc('account',{platform});notify('检查的是本地会话是否存在，实际下载权限由平台决定。');});}
function checkUpdate(){act(async()=>{update.value=await rpc('update_check');notify(update.value.available?'发现新版本，可点击更新。':'已经是最新版本。');});}
function installUpdate(){if(!window.confirm('更新完成后程序将退出并重新启动。账号会话、保存位置和下载文件会保留。是否继续？'))return;act(async()=>{notify('正在下载并校验更新文件，请勿关闭程序…');await invoke('install_update');});}
onMounted(async()=>{await refresh();timer=setInterval(refresh,700);});onUnmounted(()=>clearInterval(timer));
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="logo"><ArrowDownToLine :size="23"/><span>拾链接<small>三平台下载器</small></span></div>
      <div class="nav-label">工作空间</div>
      <button class="nav" :class="{selected:page==='download'}" @click="page='download'"><Download :size="18"/>媒体下载</button>
      <button class="nav" :class="{selected:page==='accounts'}" @click="page='accounts'"><LogIn :size="18"/>我的账号</button>
      <button class="nav" :class="{selected:page==='update'}" @click="page='update'"><RefreshCw :size="18"/>程序更新</button>
      <div class="sidebar-bottom"><div class="local-dot">本地便携版</div><span>v{{state.version}}</span><p>文件与账号会话保存在本机</p></div>
    </aside>
    <main>
      <header><div><div class="eyebrow">{{page==='download'?'YOUR MEDIA, YOUR FOLDER':page==='accounts'?'YOUR ACCOUNTS':'PROGRAM UPDATE'}}</div><h1>{{page==='download'?'把喜欢的内容，留在本地。':page==='accounts'?'登录自己的平台账号。':'让下载器保持更新。'}}</h1><p>{{page==='download'?'粘贴分享链接，一次下载视频或图文。':page==='accounts'?'使用平台官方登录页面，下载时复用你的登录状态。':'检查 GitHub 新版本，保留自己的设置与文件。'}}</p></div><span class="local-badge"><span></span>仅在本机运行</span></header>
      <template v-if="page==='download'">
        <section class="composer">
          <div class="card-heading"><span><Link :size="17"/>分享链接</span><div class="platform-chips"><span v-for="p in platforms" :key="p.id">{{p.name}}</span></div></div>
          <textarea v-model="text" placeholder="粘贴链接，或直接粘贴整段分享文案…&#10;支持多个链接，每行一个。" aria-label="分享链接" :disabled="state.busy"/>
          <div class="save-row"><Folder :size="18"/><div><small>保存位置</small><div class="path" :title="state.output">{{state.output||'正在加载…'}}</div></div><button class="light" @click="choose" :disabled="working||state.busy">更改位置</button></div>
          <div class="composer-bottom"><span><Check :size="14"/>同名文件自动编号，不覆盖已有内容</span><button class="primary" @click="download" :disabled="working||state.busy||!text.trim()"><LoaderCircle v-if="state.busy" :size="17" class="spin"/><Download v-else :size="17"/>{{state.busy?'正在下载':'开始下载'}}</button></div>
        </section>
        <div class="section-heading"><h2>下载任务 <span>{{state.jobs.length}}</span></h2><div><button v-if="failures" class="text-button" :disabled="state.busy||working" @click="act(async()=>{await rpc('retry');notify('失败任务已重新加入队列。')})"><RefreshCw :size="14"/>重试失败项</button><button class="text-button" @click="act(()=>rpc('open_folder'))"><FolderOpen :size="15"/>打开文件夹</button></div></div>
        <section class="task-list">
          <div v-if="!state.jobs.length" class="empty"><div class="empty-icon"><ArrowDownToLine :size="29"/></div><h3>从一个分享链接开始</h3><p>下载进度和结果会显示在这里</p></div>
          <article v-for="job in state.jobs" :key="job.id" class="task"><div class="platform-icon" :style="{color:platforms.find(p=>p.id===job.platform)?.color}">{{platforms.find(p=>p.id===job.platform)?.short}}</div><div class="task-content"><div class="task-title"><strong>{{job.title}}</strong><span :class="['status',{failed:job.status==='失败',complete:job.status==='已完成'}]"><Check v-if="job.status==='已完成'" :size="13"/><AlertCircle v-if="job.status==='失败'" :size="13"/>{{job.status}}{{job.quality?' · '+job.quality:''}}</span></div><div class="task-url">{{job.url}}</div><div v-if="job.status!=='失败'" class="progress"><div :style="{width:(job.percent||0)+'%'}"></div></div><div class="task-detail" :class="{failed:job.error}">{{job.error||job.progress||'等待开始'}}</div><div v-if="job.files" class="file-path" :title="job.files.join('\n')">{{job.files[0]}}</div></div></article>
        </section>
        <p class="boundary">小红书图文与B站已实测。抖音及小红书视频仍待实际链接验证；受限内容可能需要登录或安全验证。</p>
      </template>
      <template v-else-if="page==='accounts'">
        <div class="account-grid"><section class="account-card" v-for="p in platforms" :key="p.id"><div class="account-heading"><span class="platform-icon" :style="{color:p.color}">{{p.short}}</span><h2>{{p.name}}</h2></div><div class="account-status">{{state.accounts[p.id]||'未检查'}}</div><p>点击登录后，在官方页面扫码或输入你的账号。完成后返回这里检查会话。</p><button class="primary" :disabled="working||state.busy" @click="login(p.id)"><LogIn :size="16"/>登录{{p.name}}</button><button class="light" :disabled="working||state.busy" @click="account(p.id)"><RefreshCw :size="14"/>检查登录</button></section></div>
        <section class="account-note"><h3>登录状态随便携目录保存</h3><p>无需向客户端提供密码。登录操作在工具专用的 Edge 窗口完成；会话保存在程序旁的“数据”目录中。检查到会话不代表权限永久有效，若平台提示登录失效，请重新登录。</p></section>
      </template>
      <template v-else>
        <section class="account-note"><h2>程序更新 · v{{state.version}}</h2><p>从公开 GitHub Releases 检查版本，无需 GitHub 账号。更新仅替换程序文件，保留“数据”目录、保存位置与下载文件。</p><button class="primary" :disabled="working||state.busy" @click="checkUpdate"><RefreshCw :size="16"/>{{working?'正在处理…':'检查更新'}}</button><template v-if="update"><h3>{{update.available?'发现新版本':'当前已是最新版本'}} · {{update.latestVersion}}{{update.prerelease?' RC 试用版':''}}</h3><pre style="white-space:pre-wrap;font:inherit">{{update.notes}}</pre><button v-if="update.available" class="primary" :disabled="working||state.busy" @click="installUpdate"><Download :size="16"/>下载更新并重启</button></template><p>网络不通或校验失败时不会安装。替换失败或启动预检失败会回滚；失败信息位于程序旁 .media-update 目录。</p></section>
      </template>
      <div v-if="message" class="notice" :class="{failed:error}" role="status"><AlertCircle v-if="error" :size="16"/><Check v-else :size="16"/>{{message}}</div>
    </main>
  </div>
</template>
