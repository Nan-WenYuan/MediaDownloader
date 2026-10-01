import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { extensionFromUrl, fetchJson, resolveUrl, safeFilename, USER_AGENT } from "../core.mjs";
import { availablePath, downloadFile } from "../downloader.mjs";

function apiParams(finalUrl) {
  const parsed = new URL(finalUrl);
  const bvid = parsed.pathname.match(/\/(BV[0-9A-Za-z]+)/u)?.[1];
  const aid = parsed.pathname.match(/\/av(\d+)/iu)?.[1];
  if (!bvid && !aid) throw new Error("目前支持B站视频的 BV/av 链接");
  return { bvid, aid, page: Math.max(1, Number(parsed.searchParams.get("p")) || 1) };
}

const QUALITY_NAMES = { 120: "4K", 116: "1080P60", 112: "1080P+", 80: "1080P", 74: "720P60", 64: "720P", 32: "480P", 16: "360P" };

function requestHeaders(referer, cookie = "") {
  return {
    Referer: referer,
    Origin: "https://www.bilibili.com",
    "User-Agent": USER_AGENT,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

export async function resolveBilibili(inputUrl, { cookie = "" } = {}) {
  const finalUrl = inputUrl.includes("b23.tv") ? await resolveUrl(inputUrl) : inputUrl;
  const { bvid, aid, page } = apiParams(finalUrl);
  const identity = bvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${encodeURIComponent(aid)}`;
  const view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?${identity}`, {
    headers: requestHeaders("https://www.bilibili.com/", cookie),
  });
  if (view.code !== 0 || !view.data) throw new Error(view.message || "B站稿件信息获取失败");

  const selectedPage = view.data.pages?.find((item) => item.page === page) || view.data.pages?.[0];
  const cid = selectedPage?.cid || view.data.cid;
  if (!cid) throw new Error("没有找到视频 cid");

  const dashPlay = await fetchJson(
    `https://api.bilibili.com/x/player/playurl?${identity}&cid=${cid}&qn=80&fnver=0&fnval=4048&fourk=1`,
    { headers: requestHeaders(finalUrl, cookie) },
  );
  const dashVideos = dashPlay.data?.dash?.video || [];
  const qualityId = Math.max(0, ...dashVideos.map((item) => item.id).filter((id) => id <= 80));
  const sameQuality = dashVideos.filter((item) => item.id === qualityId);
  let video = sameQuality.find((item) => item.codecid === 7) || sameQuality[0];
  let audio = [...(dashPlay.data?.dash?.audio || [])].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];

  const directPlay = await fetchJson(
    `https://api.bilibili.com/x/player/playurl?${identity}&cid=${cid}&qn=80&fnver=0&fnval=1&fourk=1`,
    { headers: requestHeaders(finalUrl, cookie) },
  );
  const directQuality = directPlay.data?.durl?.length ? directPlay.data.quality || 0 : 0;
  if (directQuality > qualityId) {
    video = null;
    audio = null;
  }
  if (!video && !directPlay.data?.durl?.length) {
    throw new Error(directPlay.message || dashPlay.message || "没有取得B站可下载的视频流");
  }

  const title = safeFilename(
    `${view.data.owner?.name ? `(${view.data.owner.name})` : ""}${view.data.title}` +
      `${view.data.pages?.length > 1 ? `_P${selectedPage.page}_${selectedPage.part}` : ""}`,
  );
  return {
    platform: "bilibili",
    title,
    sourceUrl: finalUrl,
    quality: QUALITY_NAMES[video ? qualityId : directQuality] || `${video ? qualityId : directQuality}`,
    loginRecommended: !cookie && (dashPlay.data?.accept_quality || []).some((id) => id >= 80) && Math.max(qualityId, directQuality) < 80,
    merge: video && audio ? { output: `${title}.mp4` } : null,
    files: video
      ? [
          {
            role: "video",
            url: video.base_url || video.baseUrl,
            backupUrls: video.backup_url || video.backupUrl || [],
            filename: `${title}.__video.m4s`,
            headers: requestHeaders(finalUrl, cookie),
          },
          ...(audio
            ? [{ role: "audio", url: audio.base_url || audio.baseUrl, backupUrls: audio.backup_url || audio.backupUrl || [], filename: `${title}.__audio.m4s`, headers: requestHeaders(finalUrl, cookie) }]
            : []),
        ]
      : directPlay.data.durl.map((item, index) => ({
          role: "direct",
          url: item.url,
          filename:
            directPlay.data.durl.length === 1
              ? `${title}${extensionFromUrl(item.url, ".mp4")}`
              : `${title}_分段${String(index + 1).padStart(2, "0")}${extensionFromUrl(item.url, ".mp4")}`,
          headers: requestHeaders(finalUrl, cookie),
        })),
  };
}

async function runFfmpeg(ffmpegPath, video, audio, output) {
  return await new Promise((resolve, reject) => {
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", video, "-i", audio, "-c", "copy", output];
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      if (errorText.length < 8_000) errorText += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg 合并失败（${code}）：${errorText.trim()}`))));
  });
}

export async function downloadBilibili(task, outputDir, progress, options = {}) {
  const results = [];
  for (const file of task.files) {
    const destination = path.join(outputDir, file.filename);
    let lastError;
    for (const url of [file.url, ...(file.backupUrls || [])]) {
      try {
        results.push({
          ...(await downloadFile({ ...file, url, destination, onProgress: (state) => progress?.({ ...state, role: file.role }) })),
          role: file.role,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
  }
  if (task.merge) {
    const video = results.find((item) => item.role === "video")?.destination;
    const audio = results.find((item) => item.role === "audio")?.destination;
    if (video && audio) {
      const ffmpegPath = options.ffmpeg || process.env.MEDIA_FFMPEG || "D:\\Software\\ffmpeg\\bin\\ffmpeg.exe";
      if (!fs.existsSync(ffmpegPath)) throw new Error(`需要 FFmpeg 合并音视频，但未找到：${ffmpegPath}`);
      const output = await availablePath(path.join(outputDir, task.merge.output));
      progress?.({ role: "merge", text: "正在使用 FFmpeg 合并音视频" });
      await runFfmpeg(ffmpegPath, video, audio, output);
      await fs.promises.rm(video, { force: true });
      await fs.promises.rm(audio, { force: true });
      return [{ destination: output, bytes: (await fs.promises.stat(output)).size }];
    }
  }
  return results;
}
