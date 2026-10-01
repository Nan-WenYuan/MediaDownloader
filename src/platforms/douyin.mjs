import path from "node:path";
import { extensionFromUrl, fetchJson, resolveUrl, safeFilename, USER_AGENT } from "../core.mjs";
import { downloadFile } from "../downloader.mjs";

function firstUrl(container) {
  return container?.url_list?.find(Boolean) || container?.urlList?.find(Boolean) || "";
}

export async function resolveDouyin(inputUrl, { cookie = "" } = {}) {
  const finalUrl = inputUrl.includes("v.douyin.com") ? await resolveUrl(inputUrl) : inputUrl;
  const id = finalUrl.match(/\/(?:video|note)\/(\d+)/u)?.[1];
  if (!id) throw new Error("没有从抖音链接中识别出作品 ID");

  const endpoint =
    "https://www.douyin.com/aweme/v1/web/aweme/detail?" +
    new URLSearchParams({ aid: "6383", version_code: "190500", aweme_id: id });
  const result = await fetchJson(endpoint, {
    headers: { Referer: finalUrl, Accept: "application/json, text/plain, */*", ...(cookie ? { Cookie: cookie } : {}) },
  });
  if (result.status_msg) throw new Error(result.status_msg);
  const item = result.aweme_detail;
  if (!item) throw new Error("抖音没有返回作品详情；该链接可能需要登录态");

  const title = safeFilename(`(${item.author?.nickname || "抖音"})${item.preview_title || item.desc || id}`);
  const files = [];
  if (Array.isArray(item.images) && item.images.length) {
    item.images.forEach((image, index) => {
      const url = firstUrl(image);
      if (url) files.push({ url, filename: `${title}_${String(index + 1).padStart(2, "0")}${extensionFromUrl(url, ".jpg")}` });
    });
  } else {
    const stream = item.video?.play_addr_h264 || item.video?.play_addr_265 || item.video?.play_addr;
    const url = firstUrl(stream);
    if (url) files.push({ url, filename: `${title}${extensionFromUrl(url, ".mp4")}` });
  }
  if (!files.length) throw new Error("作品详情中没有找到视频或图片地址");
  return {
    platform: "douyin",
    title,
    sourceUrl: finalUrl,
    files: files.map((file) => ({
      ...file,
      headers: { Referer: "https://www.douyin.com/", "User-Agent": USER_AGENT },
    })),
  };
}

export async function downloadDouyin(task, outputDir, progress) {
  const folder = task.files.length > 1 ? path.join(outputDir, task.title) : outputDir;
  const results = [];
  for (const file of task.files) {
    results.push(await downloadFile({ ...file, destination: path.join(folder, file.filename), onProgress: progress }));
  }
  return results;
}
