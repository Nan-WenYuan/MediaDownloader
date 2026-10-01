import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { USER_AGENT } from "./core.mjs";

function readableBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export async function downloadFile(options) {
  let mediaUrl;
  try { mediaUrl = new URL(options.url); } catch { throw new Error('媒体地址格式错误，需要完整的 http/https 地址'); }
  if (!['http:', 'https:'].includes(mediaUrl.protocol)) throw new Error('媒体地址必须使用 http/https');
  for (let attempt = 0; ; attempt++) {
    try { return await downloadOnce(options); }
    catch (error) {
      const transient = error.name === 'AbortError' || error.name === 'TimeoutError' || error instanceof TypeError || /HTTP (408|429|5\d\d)|中断|超时/u.test(error.message);
      if (!transient || attempt >= 2) throw error;
      options.onProgress?.({ text: `连接中断，${attempt + 1}/2 次自动重试…` });
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
}

async function downloadOnce({ url, destination, headers = {}, onProgress }) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  destination = await availablePath(destination);
  const partial = `${destination}.part`;
  let existing = 0;
  try {
    existing = (await fs.promises.stat(partial)).size;
  } catch {}

  const requestHeaders = { "User-Agent": USER_AGENT, ...headers };
  if (existing > 0) requestHeaders.Range = `bytes=${existing}-`;

  const controller = new AbortController();
  let idleTimer;
  const resetTimeout = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(new DOMException('下载60秒无数据，已超时', 'TimeoutError')), 60000); };
  resetTimeout();
  try {
  let response = await fetch(url, { redirect: "follow", headers: requestHeaders, signal: controller.signal });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`下载失败：HTTP ${response.status}`); }
  if (existing > 0 && response.status !== 206) {
    await response.body?.cancel();
    existing = 0;
    delete requestHeaders.Range;
    response = await fetch(url, { redirect: "follow", headers: requestHeaders, signal: controller.signal });
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`下载失败：HTTP ${response.status}`); }
  if (response.status === 206) {
    const start = response.headers.get('content-range')?.match(/^bytes (\d+)-/u)?.[1];
    if (Number(start) !== existing || start === undefined) { await response.body.cancel(); throw new Error('服务器返回错误的续传位置，已停止以避免文件损坏'); }
  }

  const remaining = Number(response.headers.get("content-length")) || 0;
  const total = existing + remaining;
  let received = existing;
  let lastUpdate = 0;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      resetTimeout();
      received += chunk.length;
      const now = Date.now();
      if (now - lastUpdate >= 250 || received === total) {
        lastUpdate = now;
        onProgress?.({ received, total, text: `${readableBytes(received)} / ${readableBytes(total)}` });
      }
      callback(null, chunk);
    },
  });

  const stream = fs.createWriteStream(partial, { flags: existing > 0 ? "a" : "w" });
  await pipeline(Readable.fromWeb(response.body), progress, stream);
  if (remaining && received !== total) throw new Error('下载数据不完整，连接中断');
  await fs.promises.rename(partial, destination);
  onProgress?.({ received, total, text: `${readableBytes(received)} / ${readableBytes(total)}` });
  return { destination, bytes: received };
  } finally { clearTimeout(idleTimer); }
}

export async function availablePath(destination) {
  try {
    await fs.promises.access(destination);
  } catch {
    return destination;
  }
  const parsed = path.parse(destination);
  for (let index = 1; ; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    try {
      await fs.promises.access(candidate);
    } catch {
      return candidate;
    }
  }
}
