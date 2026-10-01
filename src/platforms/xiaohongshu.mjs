import path from "node:path";
import {
  extensionFromUrl,
  htmlDecode,
  resolveUrl,
  safeFilename,
  USER_AGENT,
} from "../core.mjs";
import { downloadFile } from "../downloader.mjs";
import { readXiaohongshuPage } from "../auth.mjs";

export function parseInitialState(html) {
  const marker = "window.__INITIAL_STATE__";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const objectStart = html.indexOf("{", markerIndex + marker.length);
  const scriptEnd = html.indexOf("</script>", objectStart);
  if (objectStart < 0 || scriptEnd < 0) return null;
  const source = html.slice(objectStart, scriptEnd).trim().replace(/;\s*$/u, "").replaceAll(":undefined", ":null");
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

export function findNote(root, noteId) {
  const direct = root?.note?.noteDetailMap?.[noteId]?.note || root?.noteData?.data?.noteData;
  if (direct) return direct;
  const queue = [{ value: root, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value) || depth > 8) continue;
    seen.add(value);
    const id = String(value.noteId || value.note_id || value.id || "");
    if (id === noteId && (value.video || value.imageList || value.images)) return value.noteCard || value.note || value;
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

function imageUrl(image) {
  return (
    image?.urlDefault ||
    image?.urlPre ||
    image?.url ||
    image?.infoList?.find((entry) => entry?.url)?.url ||
    ""
  );
}

function collectVideoUrls(value, output = new Set(), depth = 0, seen = new Set()) {
  if (depth > 9 || value == null) return output;
  if (typeof value === "string") {
    if (/^https?:\/\//iu.test(value) && /(sns-video|\.mp4(?:\?|$))/iu.test(value)) output.add(value.replaceAll("\\u002F", "/"));
    return output;
  }
  if (typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  for (const child of Object.values(value)) collectVideoUrls(child, output, depth + 1, seen);
  return output;
}

export async function resolveXiaohongshu(inputUrl, { cookie = "" } = {}) {
  const finalUrl = /xhslink\.com/iu.test(inputUrl) ? await resolveUrl(inputUrl) : inputUrl;
  const noteId = finalUrl.match(/\/(?:explore|discovery\/item)\/([0-9a-f]+)/iu)?.[1];
  if (!noteId) throw new Error("没有从小红书链接中识别出笔记 ID");

  let html = '';
  try {
  const response = await fetch(finalUrl, {
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, Referer: "https://www.xiaohongshu.com/", ...(cookie ? { Cookie: cookie } : {}) },
  });
  if (!response.ok) throw new Error(`小红书页面访问失败：HTTP ${response.status}`);
  html = await response.text();
  } catch { /* 浏览器页面兜底可处理接口与页面环境不一致的情况。 */ }
  const state = parseInitialState(html);
  let note = state ? findNote(state, noteId) : null;
  if (!note || !(note.video || note.imageList?.length || note.images?.length)) {
    note = await readXiaohongshuPage(finalUrl, noteId);
  }
  return taskFromNote(note, noteId, finalUrl);
}

export function taskFromNote(note, noteId, finalUrl) {
  if (!note) throw new Error('小红书未取得笔记详情，不能将网站占位图作为下载资源');
  const title = safeFilename(
    `(${note?.user?.nickname || note?.user?.nickName || "小红书"})` +
      `${note?.displayTitle || note?.title || note?.desc || noteId}`,
  );
  const files = [];

  const originKey = note?.video?.consumer?.originVideoKey;
  if (originKey) {
    files.push({ url: `https://sns-video-hw.xhscdn.com/${originKey}`, filename: `${title}.mp4` });
  } else {
    const videos = [...collectVideoUrls(note.video)];
    if (videos[0]) files.push({ url: videos[0], filename: `${title}${extensionFromUrl(videos[0], ".mp4")}` });
  }

  if (!files.length) {
    const images = note?.imageList || note?.images || [];
    images.forEach((image, index) => {
      const url = imageUrl(image);
      const format = url.match(/(?:!.*?|[?&]format=|\/format\/)(webp|png|jpeg|jpg)(?:[^a-z]|$)/iu)?.[1]?.toLowerCase();
      if (url) files.push({ url, filename: `${title}_${String(index + 1).padStart(2, "0")}${format ? '.' + format : extensionFromUrl(url, ".jpg")}` });
    });
  }

  if (!files.length) {
    throw new Error("笔记详情中没有找到视频或图片地址，请登录后重试");
  }
  return {
    platform: "xiaohongshu",
    title,
    sourceUrl: finalUrl,
    files: files.map((file) => ({
      ...file,
      url: normalizeMediaUrl(file.url, finalUrl),
      headers: { Referer: finalUrl, "User-Agent": USER_AGENT },
    })),
  };
}

export function normalizeMediaUrl(value, baseUrl) {
  const url = new URL(htmlDecode(value), baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || /picasso-static|fe-platform/iu.test(url.href)) {
    throw new Error('小红书返回了网站占位资源，未取得笔记媒体地址');
  }
  return url.href;
}

export async function downloadXiaohongshu(task, outputDir, progress) {
  const folder = task.files.length > 1 ? path.join(outputDir, task.title) : outputDir;
  const results = [];
  for (const file of task.files) {
    results.push(await downloadFile({ ...file, destination: path.join(folder, file.filename), onProgress: progress }));
  }
  return results;
}
