import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getCookieHeader, loginUrl, startAuthBrowser, loginStatus } from './auth.mjs';
import { extractUrls, detectPlatform } from './core.mjs';
import { resolveDouyin, downloadDouyin } from './platforms/douyin.mjs';
import { resolveXiaohongshu, downloadXiaohongshu } from './platforms/xiaohongshu.mjs';
import { resolveBilibili, downloadBilibili } from './platforms/bilibili.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsPath = path.join(root, '.runtime', 'settings.json');
const adapters = { douyin: [resolveDouyin, downloadDouyin], xiaohongshu: [resolveXiaohongshu, downloadXiaohongshu], bilibili: [resolveBilibili, downloadBilibili] };
const labels = { douyin: '抖音', xiaohongshu: '小红书', bilibili: 'B站' };
const aliases = { '1': 'douyin', '抖音': 'douyin', '2': 'xiaohongshu', '小红书': 'xiaohongshu', '3': 'bilibili', 'b站': 'bilibili' };
const help = () => console.log(`\n三平台终端下载工具
粘贴链接或分享文案；支持多行，空行开始下载，完成后可继续使用。
  :login 1 / 2 / 3    登录抖音 / 小红书 / B站
  :dir D:\\我的下载    更改并记住保存目录
  :open               打开保存文件夹
  :retry              重试上一批失败链接
  :help               帮助
  :quit               退出；Ctrl+C 中断下载并保留 .part 文件
抖音尚未实测；小红书已验证图文样例，其他链接可能需要登录或手动验证。\n`);

async function main() {
  // 保留原命令行参数用法；无参数时进入持续交互。
  if (process.argv.length > 2) {
    await new Promise((resolve, reject) => { const child = spawn(process.execPath, [path.join(root, 'src', 'cli.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' }); child.on('error', reject); child.on('exit', code => { process.exitCode = code ?? 1; resolve(); }); }); return;
  }
  let output = path.join(root, '下载结果'), failed = [];
  try { const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8')); if (typeof saved.output === 'string' && path.isAbsolute(saved.output)) output = saved.output; } catch {}
  async function save() { await fs.mkdir(path.dirname(settingsPath), { recursive: true }); await fs.writeFile(settingsPath, JSON.stringify({ output }, null, 2)); }
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const read = async (prompt = '') => { process.stdout.write(prompt); const line = await lines.next(); return line.done ? null : line.value; };
  process.once('SIGINT', () => { console.log('\n已中断，未完成文件保留；下次下载同一链接可续传（服务器支持时）。'); process.exit(130); });
  async function batch(urls) {
    const errors = []; await fs.mkdir(output, { recursive: true });
    console.log(`\n共 ${urls.length} 条，保存到：${output}`);
    for (const [index, url] of urls.entries()) {
      const platform = detectPlatform(url), adapter = adapters[platform];
      console.log(`\n[${index + 1}/${urls.length}] ${labels[platform] || '未知平台'} ${url}`);
      try {
        if (!adapter) throw Error('目前只支持抖音、小红书和B站');
        console.log('正在解析…');
        const cookie = await getCookieHeader(loginUrl(platform));
        const task = await adapter[0](url, { cookie });
        console.log(`标题：${task.title}\n文件：${task.files.length}${task.quality ? '，清晰度：' + task.quality : ''}`);
        if (platform === 'bilibili' && !['1080P','1080P+','1080P60','4K'].includes(task.quality)) console.log('当前未取得1080P，需要高清可用 :login 3 重新登录。');
        const files = await adapter[1](task, output, ({ text, role }) => { if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${role === 'merge' ? '合并' : '下载'}：${text}`); });
        console.log('\n已保存：'); for (const file of files) console.log(`  ${file.destination}`);
      } catch (error) { errors.push(url); console.log(`\n失败：${error.message}`); if (platform) console.log(`可先运行 :login ${platform}；小红书请保留分享链接中的 xsec_token。`); }
    }
    failed = errors; console.log(`\n完成：成功 ${urls.length - errors.length}，失败 ${errors.length}${errors.length ? '。输入 :retry 重试失败项。' : ''}`);
  }
  help(); console.log(`保存目录：${output}`);
  try {
    while (true) {
      const first = await read('\n粘贴链接或输入命令 > '); if (first === null) break; if (!first.trim()) continue;
      try {
        if (first.startsWith(':')) {
          const [, command, raw = ''] = first.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u);
          if (command === ':quit' || command === ':q') break;
          if (command === ':help') help();
          else if (command === ':dir') {
            if (!raw.trim()) throw Error('用法：:dir D:\\我的下载');
            const candidate = path.resolve(raw.trim().replace(/^"|"$/gu, '')); await fs.mkdir(candidate, { recursive: true });
            const previous = output; output = candidate; try { await save(); } catch (error) { output = previous; throw error; } console.log(`保存目录：${output}`);
          } else if (command === ':retry') { if (failed.length) await batch([...failed]); else console.log('没有失败项。'); }
          else if (command === ':open') {
            await fs.mkdir(output, { recursive: true }); await new Promise((resolve, reject) => { const child = spawn('explorer.exe', [output], { windowsHide: true, stdio: 'ignore' }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
          } else if (command === ':login') {
            const value = raw.toLowerCase(), platform = aliases[value] || value; if (!adapters[platform]) throw Error('用法：:login 1（抖音）、2（小红书）或3（B站）');
            console.log(`打开${labels[platform]}登录窗口…`); await startAuthBrowser({ interactive: true, platform });
            await read('完成网页登录后回到这里按 Enter：'); const status = await loginStatus(platform);
            console.log(status.cookieCount ? '已读取会话数据；有效性以作品解析结果为准。' : '未读到会话数据，请重新登录。');
          } else console.log('未知命令，输入 :help 查看帮助。');
          continue;
        }
        console.log('可继续粘贴，输入空行开始下载。'); const content = [first];
        while (true) { const line = await read(); if (line === null || !line.trim()) break; content.push(line); }
        const urls = extractUrls(content.join('\n')); if (urls.length) await batch(urls); else console.log('没有找到链接，请粘贴完整分享文案。');
      } catch (error) { console.log(`操作失败：${error.message}`); }
    }
  } finally { rl.close(); }
}
main().catch(error => { console.error(`错误：${error.message}`); process.exitCode = 1; });
