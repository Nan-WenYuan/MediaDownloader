import test from "node:test";
import assert from "node:assert/strict";
import { detectPlatform, extractUrls, safeFilename } from "../src/core.mjs";
import { normalizeMediaUrl, parseInitialState, taskFromNote } from "../src/platforms/xiaohongshu.mjs";

test("从分享文案中提取并清理多个链接", () => {
  assert.deepEqual(extractUrls("抖音 https://v.douyin.com/abc/，\nB站：https://b23.tv/xyz。"), [
    "https://v.douyin.com/abc/",
    "https://b23.tv/xyz",
  ]);
});

test("识别三个平台", () => {
  assert.equal(detectPlatform("https://www.douyin.com/video/1"), "douyin");
  assert.equal(detectPlatform("https://www.bilibili.com/video/BV1xx"), "bilibili");
  assert.equal(detectPlatform("https://www.xiaohongshu.com/explore/123"), "xiaohongshu");
});

test("Windows 文件名清理", () => {
  assert.equal(safeFilename('a:b/c*?"d'), "a_b_c_d");
  assert.equal(safeFilename("CON"), "_CON");
});

test("解析小红书 INITIAL_STATE", () => {
  const html = '<script>window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"id":"1"}}},"x":undefined};</script>';
  assert.deepEqual(parseInitialState(html), { noteData: { data: { noteData: { id: "1" } } }, x: null });
});

test('小红书资源补全协议，拒绝网站占位图和无详情任务', () => {
  assert.equal(normalizeMediaUrl('//sns-img.xhscdn.com/image.jpg', 'https://www.xiaohongshu.com/explore/123'), 'https://sns-img.xhscdn.com/image.jpg');
  assert.throws(() => normalizeMediaUrl('//picasso-static.xiaohongshu.com/fe-platform/default.png', 'https://www.xiaohongshu.com/'), /占位/u);
  assert.throws(() => taskFromNote(null, '123', 'https://www.xiaohongshu.com/'), /详情/u);
  const task = taskFromNote({ title: '笔记', user: { nickname: '作者' }, imageList: [{ urlDefault: '//sns-img.xhscdn.com/a.jpg' }, { urlDefault: 'https://sns-img.xhscdn.com/b.jpg' }] }, '123', 'https://www.xiaohongshu.com/explore/123');
  assert.equal(task.files.length, 2);
  assert.equal(task.files[0].url, 'https://sns-img.xhscdn.com/a.jpg');
  const webp = taskFromNote({ title: '图片', imageList: [{ urlDefault: '//sns-img.xhscdn.com/a!nd_dft_wlteh_webp_3' }] }, '123', 'https://www.xiaohongshu.com/');
  assert.ok(webp.files[0].filename.endsWith('.webp'));
});
