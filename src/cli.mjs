import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { getCookieHeader, loginStatus, loginUrl, startAuthBrowser } from "./auth.mjs";
import { detectPlatform, extractUrls } from "./core.mjs";
import { downloadBilibili, resolveBilibili } from "./platforms/bilibili.mjs";
import { downloadDouyin, resolveDouyin } from "./platforms/douyin.mjs";
import { downloadXiaohongshu, resolveXiaohongshu } from "./platforms/xiaohongshu.mjs";

const adapters = {
  bilibili: { label: "B站", resolve: resolveBilibili, download: downloadBilibili },
  douyin: { label: "抖音", resolve: resolveDouyin, download: downloadDouyin },
  xiaohongshu: { label: "小红书", resolve: resolveXiaohongshu, download: downloadXiaohongshu },
};

function parseArguments(argv) {
  const text = [];
  let output = path.resolve("下载结果");
  let infoOnly = false;
  let login = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-o" || arg === "--output") {
      const next = argv[index + 1];
      if (!next) throw new Error(`${arg} 后面必须提供保存目录`);
      output = path.resolve(next);
      index += 1;
    } else if (arg === "--info-only") {
      infoOnly = true;
    } else if (arg === "--login") {
      login = argv[index + 1] || "bilibili";
      if (argv[index + 1] && !argv[index + 1].startsWith("-")) index += 1;
    } else if (arg === "-h" || arg === "--help") {
      return { help: true, output, infoOnly, login, text };
    } else {
      text.push(arg);
    }
  }
  return { help: false, output, infoOnly, login, text };
}

async function readInteractiveInput() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("请粘贴抖音、B站或小红书链接（支持整段分享文案和多行；输入空行开始）：");
  const lines = [];
  while (true) {
    const line = await rl.question(lines.length ? "" : "> ");
    if (!line.trim()) break;
    lines.push(line);
  }
  rl.close();
  return lines.join("\n");
}

function printHelp() {
  console.log(`三平台媒体下载工具

用法：
  node src/cli.mjs "链接或分享文案"
  node src/cli.mjs 链接1 链接2 -o "D:\\下载"
  node src/cli.mjs --info-only 链接
  node src/cli.mjs --login bilibili

不提供链接时进入粘贴模式。默认保存到当前目录的“下载结果”。`);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.login) {
    if (!adapters[args.login]) throw new Error("--login 仅支持 bilibili、douyin、xiaohongshu");
    console.log(`正在打开独立登录窗口：${loginUrl(args.login)}`);
    await startAuthBrowser({ interactive: true, platform: args.login });
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("请在打开的 Edge 窗口完成登录，然后回到这里按 Enter：");
    rl.close();
    const status = await loginStatus(args.login);
    console.log(status.cookieCount ? `已检测到 ${status.cookieCount} 项会话 Cookie，登录数据会保存在项目的专用配置中。` : "没有检测到会话 Cookie，请确认登录已经完成。 ");
    return;
  }
  const input = args.text.length ? args.text.join("\n") : await readInteractiveInput();
  const urls = extractUrls(input);
  if (!urls.length) throw new Error("没有识别到 http/https 链接");

  console.log(`识别到 ${urls.length} 条链接，保存目录：${args.output}`);
  let succeeded = 0;
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    const platform = detectPlatform(url);
    const adapter = platform ? adapters[platform] : null;
    console.log(`\n[${index + 1}/${urls.length}] ${adapter?.label || "未知平台"}  ${url}`);
    if (!adapter) {
      console.error("  跳过：目前只支持抖音、B站和小红书链接");
      continue;
    }
    try {
      process.stdout.write("  正在解析…");
      const cookie = await getCookieHeader(loginUrl(platform));
      const task = await adapter.resolve(url, { cookie });
      process.stdout.write("\r");
      console.log(`  标题：${task.title}`);
      console.log(`  文件：${task.files.length}${task.quality ? `，清晰度：${task.quality}` : ""}`);
      if (task.loginRecommended) console.log("  提示：登录后可取得 1080P；运行 npm start -- --login bilibili");
      if (!args.infoOnly) {
        process.stdout.write("  下载：等待数据…");
        await adapter.download(task, args.output, ({ text, role }) => {
          const label = role === "video" ? "视频" : role === "audio" ? "音频" : role === "merge" ? "合并" : "下载";
          process.stdout.write(`\r  ${label}：${text}      `);
        });
        process.stdout.write("\n");
      }
      succeeded += 1;
    } catch (error) {
      process.stdout.write("\n");
      console.error(`  失败：${error.message}`);
    }
  }
  console.log(`\n完成：${succeeded}/${urls.length} 条${args.infoOnly ? "解析成功" : "处理成功"}。`);
  if (succeeded !== urls.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
