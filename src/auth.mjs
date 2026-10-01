import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const EDGE_EXE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CDP_PORT = Number(process.env.MEDIA_CDP_PORT || 9333);
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AUTH_PROFILE = path.join(process.env.MEDIA_DATA_DIR || path.join(PROJECT_ROOT, '.runtime'), "edge-profile");

const LOGIN_URLS = {
  bilibili: "https://passport.bilibili.com/login",
  douyin: "https://www.douyin.com/",
  xiaohongshu: "https://www.xiaohongshu.com/",
};

async function getVersion() {
  try {
    const response = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForCdp(timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = await getVersion();
    if (version?.webSocketDebuggerUrl) return version;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("登录浏览器启动超时");
}

export async function startAuthBrowser({ interactive = false, platform } = {}) {
  const existing = await getVersion();
  if (existing && !interactive) return { started: false, version: existing };
  if (existing && interactive) {
    try {
      await cdpCall(existing.webSocketDebuggerUrl, "Browser.close");
    } catch {}
    const deadline = Date.now() + 5_000;
    while ((await getVersion()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  if (!fs.existsSync(EDGE_EXE)) throw new Error(`未找到 Edge：${EDGE_EXE}`);
  await fs.promises.mkdir(AUTH_PROFILE, { recursive: true });
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${AUTH_PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (!interactive) args.push("--headless=new", "--disable-gpu");
  args.push(interactive ? LOGIN_URLS[platform] || LOGIN_URLS.bilibili : "about:blank");
  const child = spawn(EDGE_EXE, args, { detached: true, stdio: "ignore", windowsHide: !interactive });
  let launchError;
  child.once('error', error => { launchError = error; });
  child.unref();
  try { return { started: true, version: await waitForCdp(), child }; }
  catch (error) { throw launchError || error; }
}

async function cdpCall(webSocketUrl, method, params = {}) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const id = 1;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`浏览器会话调用超时：${method}`));
    }, 8_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id, method, params })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("无法连接登录浏览器"));
    });
  });
}

export async function getCookieHeader(url, { startIfProfileExists = true } = {}) {
  let version = await getVersion();
  if (!version && startIfProfileExists && fs.existsSync(AUTH_PROFILE)) {
    version = (await startAuthBrowser({ interactive: false })).version;
  }
  if (!version?.webSocketDebuggerUrl) return "";
  const result = await cdpCall(version.webSocketDebuggerUrl, "Storage.getCookies");
  const host = new URL(url).hostname;
  const now = Date.now() / 1000;
  return (result.cookies || [])
    .filter((cookie) => {
      const domain = String(cookie.domain || "").replace(/^\./u, "");
      return (host === domain || host.endsWith(`.${domain}`)) && (!cookie.expires || cookie.expires > now);
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export async function loginStatus(platform) {
  const cookie = await getCookieHeader(LOGIN_URLS[platform], { startIfProfileExists: false });
  return { cookieCount: cookie ? cookie.split("; ").length : 0 };
}

export function loginUrl(platform) {
  return LOGIN_URLS[platform];
}

export async function closeAuthBrowser() {
  const version = await getVersion();
  if (version?.webSocketDebuggerUrl) await cdpCall(version.webSocketDebuggerUrl, 'Browser.close').catch(() => {});
}

// 在工具自己的登录配置中加载笔记，让站点脚本完成详情请求。
export async function readXiaohongshuPage(url, noteId) {
  const { version } = await startAuthBrowser();
  const browserSocket = version.webSocketDebuggerUrl;
  const { targetId } = await cdpCall(browserSocket, 'Target.createTarget', { url });
  let diagnostic = '';
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const response = await fetch(`${CDP_BASE}/json/list`, { signal: AbortSignal.timeout(2000) });
      const target = (await response.json()).find(item => item.id === targetId);
      if (target?.webSocketDebuggerUrl) {
        const result = await cdpCall(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
          expression: `(() => {
            const state = window.__INITIAL_STATE__;
            const map = state?.note?.noteDetailMap;
            const id = ${JSON.stringify(noteId)};
            const entry = map?.[id];
            const note = entry?.note || entry;
            const text = document.body?.innerText || '';
            return JSON.stringify({note: note && (note.imageList?.length || note.video) ? note : null,
              title: document.title, message: text.slice(0, 1600)});
          })()`, returnByValue: true,
        });
        if (result.result?.value) {
          const data = JSON.parse(result.result.value);
          if (data.note) return data.note;
          diagnostic = data.message || data.title;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (/验证码|安全验证|验证后|验证身份/u.test(diagnostic)) throw new Error('小红书要求安全验证，请用 :login 2 打开专用浏览器并手动完成验证后重试');
    if (/登录|扫码/u.test(diagnostic)) throw new Error('小红书未返回笔记详情，请用 :login 2 登录工具专用浏览器后重试');
    if (/不存在|无法查看|已删除|违规|失效/u.test(diagnostic)) throw new Error('小红书页面提示笔记不可查看，可能已删除或分享链接失效，请重新复制分享链接');
    throw new Error('小红书页面未加载出笔记详情，请用 :login 2 登录后重试；请保留完整分享链接');
  } finally { await cdpCall(browserSocket, 'Target.closeTarget', { targetId }).catch(() => {}); }
}
