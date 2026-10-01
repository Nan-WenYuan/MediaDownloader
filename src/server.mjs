import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { extractUrls, detectPlatform } from './core.mjs';
import { getCookieHeader, loginUrl, startAuthBrowser } from './auth.mjs';
import { resolveBilibili, downloadBilibili } from './platforms/bilibili.mjs';
import { resolveDouyin, downloadDouyin } from './platforms/douyin.mjs';
import { resolveXiaohongshu, downloadXiaohongshu } from './platforms/xiaohongshu.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapters = { bilibili: [resolveBilibili, downloadBilibili], douyin: [resolveDouyin, downloadDouyin], xiaohongshu: [resolveXiaohongshu, downloadXiaohongshu] };
const state = { busy: false, output: path.join(root, '下载结果'), jobs: [] };
const clients = new Set();
const publish = () => { for (const client of clients) client.write(`data: ${JSON.stringify(state)}\n\n`); };
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };

async function processQueue() {
  try {
    for (const job of state.jobs) {
      try {
        job.status = '正在解析'; publish();
        const [resolve, download] = adapters[job.platform];
        const cookie = await getCookieHeader(loginUrl(job.platform));
        const task = await resolve(job.url, { cookie });
        job.title = task.title; job.quality = task.quality; job.status = '正在下载'; publish();
        const results = await download(task, state.output, progress => {
          job.progress = progress.text;
          job.percent = progress.total ? Math.round(progress.received / progress.total * 100) : null;
          if (progress.role === 'merge') job.status = '正在合并';
          publish();
        });
        job.status = '完成'; job.percent = 100; job.files = results.map(item => item.destination); job.progress = `${results.length} 个文件已保存`;
      } catch (error) { job.status = '失败'; job.error = error.message; }
      publish();
    }
  } finally { state.busy = false; publish(); }
}

export const server = http.createServer(async (req, res) => {
  // 仅接受本机页面，避免其他网站向本地接口提交下载任务。
  const expectedHost = `127.0.0.1:${server.address()?.port}`;
  if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) return json(res, 403, { error: '仅接受本机工具页面的请求' });
  const pathname = new URL(req.url, `http://${expectedHost}`).pathname;
  try {
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" });
      return res.end(await fs.readFile(path.join(root, 'src', 'ui.html')));
    }
    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, state);
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      clients.add(res); res.write(`data: ${JSON.stringify(state)}\n\n`);
      req.on('close', () => clients.delete(res)); return;
    }
    if (req.method !== 'POST') return json(res, 404, { error: '不存在的接口' });
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 100000) return json(res, 413, { error: '输入内容过长' }); }
    const input = JSON.parse(body || '{}');
    if (pathname === '/api/download') {
      if (state.busy) return json(res, 409, { error: '请等待当前下载完成' });
      const urls = extractUrls(input.text || '');
      if (!urls.length) return json(res, 400, { error: '请粘贴至少一个分享链接' });
      if (urls.some(url => !detectPlatform(url))) return json(res, 400, { error: '仅支持抖音、小红书和B站链接' });
      const output = String(input.output || state.output).trim();
      if (!path.isAbsolute(output)) return json(res, 400, { error: '保存目录必须为绝对路径，例如 D:\\我的下载' });
      await fs.mkdir(output, { recursive: true });
      state.output = output; state.jobs = urls.map((url, id) => ({ id, url, platform: detectPlatform(url), status: '等待中', percent: 0 }));
      state.busy = true; publish(); json(res, 202, { ok: true }); void processQueue(); return;
    }
    if (pathname === '/api/login') {
      if (state.busy) return json(res, 409, { error: '下载时不能切换登录浏览器' });
      if (!adapters[input.platform]) return json(res, 400, { error: '未知平台' });
      await startAuthBrowser({ interactive: true, platform: input.platform });
      return json(res, 200, { message: '请在打开的 Edge 中登录，完成后回到此窗口即可。' });
    }
    if (pathname === '/api/open-folder') {
      await fs.mkdir(state.output, { recursive: true });
      await new Promise((resolve, reject) => {
        const child = spawn('explorer.exe', [state.output], { windowsHide: true, stdio: 'ignore' });
        child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
      });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: '不存在的接口' });
  } catch (error) { json(res, 500, { error: error.message }); }
});

server.listen(Number(process.env.DOWNLOADER_PORT || 17856), '127.0.0.1', () => console.log(`下载工具已启动：http://127.0.0.1:${server.address().port}\n关闭此终端即停止服务。`));
server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
