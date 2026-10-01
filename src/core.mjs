import path from "node:path";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";

const TRAILING_PUNCTUATION = /[),.;!?\]}>，。；！？）》】」』]+$/u;

export function extractUrls(text) {
  return [...String(text).matchAll(/https?:\/\/[^\s<>"']+/giu)]
    .map((match) => match[0].replace(TRAILING_PUNCTUATION, ""))
    .filter((url, index, items) => items.indexOf(url) === index);
}

export function detectPlatform(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (host === "douyin.com" || host.endsWith(".douyin.com")) return "douyin";
  if (host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv") {
    return "bilibili";
  }
  if (
    host === "xiaohongshu.com" ||
    host.endsWith(".xiaohongshu.com") ||
    host === "xhslink.com" ||
    host.endsWith(".xhslink.com") ||
    host === "rednote.com" ||
    host.endsWith(".rednote.com")
  ) {
    return "xiaohongshu";
  }
  return null;
}

export function safeFilename(value, fallback = "未命名") {
  let result = String(value || fallback)
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/[\\/:*?"<>|\r\n.]+/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[ .]+$/gu, "");

  if (!result) result = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(result)) result = `_${result}`;
  return [...result].slice(0, 120).join("");
}

export function extensionFromUrl(url, fallback) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.[a-z0-9]{2,5}$/u.test(ext)) return ext;
  } catch {}
  return fallback;
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
    ...options,
    headers: { "User-Agent": USER_AGENT, ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口没有返回 JSON（HTTP ${response.status}）`);
  }
}

export async function resolveUrl(url, headers = {}) {
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, ...headers },
    });
  } catch {}
  if (!response?.ok) {
    response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, ...headers },
    });
  }
  if (!response.ok) throw new Error(`链接访问失败：HTTP ${response.status}`);
  return response.url;
}

export function htmlDecode(value) {
  return String(value || "")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

export function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "iu"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "iu"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return htmlDecode(match[1]);
  }
  return "";
}
