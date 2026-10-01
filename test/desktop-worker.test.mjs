import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../src/desktop-worker.mjs', import.meta.url));
function worker(root) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, MEDIA_APP_DIR: root, MEDIA_DATA_DIR: path.join(root, '数据'), MEDIA_CDP_PORT: '19998' }, stdio: ['pipe','pipe','pipe'] });
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  return { child, async request(command, args={}) {
    child.stdin.write(JSON.stringify({command,args})+'\n');
    const line = await lines.next(); if(line.done)throw Error('服务提前退出');return JSON.parse(line.value);
  }, async close(){ const exited=new Promise(resolve=>child.once('exit',resolve));await this.request('shutdown');child.stdin.end();await exited;reader.close(); } };
}
test('桌面服务协议与中文空格下载目录跨启动持久保存', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'media-desktop-test-'));
  let service;
  try {
    service = worker(root);
    assert.equal((await service.request('state')).result.version, '0.3.2');
    const output = path.join(root,'中文 空格下载');
    assert.equal((await service.request('set_output',{output})).result.output,output);
    assert.match((await service.request('download',{text:'https://example.com/a'})).error,/仅支持/u);
    assert.equal((await service.request('state')).result.busy,false);
    await service.close(); service=worker(root);
    assert.equal((await service.request('state')).result.output,output);
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(root,'数据/settings.json'),'utf8'))),['output']);
  } finally { if(service)await service.close(); await fs.rm(root,{recursive:true,force:true}); }
});
