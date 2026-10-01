import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadFile } from '../src/downloader.mjs';

test('临时错误重试、Range续传和同名避让不会损坏文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-downloader-test-'));
  let attempts = 0;
  const server = http.createServer((req, res) => {
    if (++attempts === 1) { res.writeHead(503); res.end(); return; }
    assert.equal(req.headers.range, 'bytes=3-');
    res.writeHead(206, { 'Content-Range': 'bytes 3-5/6', 'Content-Length': 3 }); res.end('def');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const target = path.join(dir, '中文.mp4');
    await fs.writeFile(target, 'original');
    await fs.writeFile(path.join(dir, '中文 (1).mp4.part'), 'abc');
    const result = await downloadFile({ url: `http://127.0.0.1:${server.address().port}`, destination: target });
    assert.equal(await fs.readFile(target, 'utf8'), 'original');
    assert.equal(await fs.readFile(result.destination, 'utf8'), 'abcdef');
    assert.equal(attempts, 2);
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

test('错误的Range起点被拒绝，已有部分文件保持原样', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-downloader-test-'));
  const server = http.createServer((_req, res) => { res.writeHead(206, { 'Content-Range': 'bytes 0-2/6', 'Content-Length': 3 }); res.end('abc'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const target = path.join(dir, 'video.mp4'); await fs.writeFile(target + '.part', 'abc');
    await assert.rejects(downloadFile({ url: `http://127.0.0.1:${server.address().port}`, destination: target }), /续传位置/u);
    assert.equal(await fs.readFile(target + '.part', 'utf8'), 'abc');
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});
