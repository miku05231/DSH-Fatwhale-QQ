import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  HOST_DSH_ENV, detectHostDsh, followsHostCommand, getHostDsh, hostDshRootFor, setHostDsh,
} from '../src/dsh-host.js';
import { resolveDshInstallRoot } from '../src/dsh-desktop.js';
import { inspectDshRuntime } from '../src/dsh.js';
import { resolveKernelModule } from '../src/chat-only.js';

function writePkg(dir, pkg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
}

/** 造两种宿主布局：Desktop（app.asar/dsh/node_modules 下并排）和 npm 全局安装的 dsh web */
function layouts() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-host-'));
  const desktopModules = path.join(root, 'Desktop', 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai');
  writePkg(path.join(desktopModules, 'dsh'), { name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' });
  writePkg(path.join(desktopModules, 'dsh-desktop-host'), { name: '@deepseek-ai/dsh-desktop-host', version: '0.2.2-rc.5' });
  const webRoot = path.join(root, 'npm', 'node_modules', '@deepseek-ai', 'dsh');
  writePkg(webRoot, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.5' });
  fs.mkdirSync(path.join(webRoot, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'lib', 'bin.js'), '');
  return {
    root,
    desktopEntry: path.join(desktopModules, 'dsh-desktop-host', 'lib', 'index.js'),
    desktopRoot: path.join(desktopModules, 'dsh'),
    webEntry: path.join(webRoot, 'lib', 'bin.js'),
    webRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('认出 Desktop 和 dsh web 两种宿主，普通 node 脚本认不出', () => {
  const l = layouts();
  try {
    assert.deepEqual(detectHostDsh({ argv: ['electron', l.desktopEntry] }), { root: l.desktopRoot, version: '0.2.2-rc.5' });
    assert.deepEqual(detectHostDsh({ argv: ['node', l.webEntry] }), { root: l.webRoot, version: '0.2.1-rc.5' });
    assert.equal(detectHostDsh({ argv: ['node', path.join(l.root, 'elsewhere', 'script.mjs')] }), null);
    assert.equal(detectHostDsh({ argv: ['node'] }), null);
  } finally {
    l.cleanup();
  }
});

test('只有 dsh.command 没指定具体路径时才跟随宿主', () => {
  for (const value of [undefined, '', 'dsh', ' DSH ', 'auto']) assert.equal(followsHostCommand(value), true, String(value));
  for (const value of ['C:\\dsh\\lib\\bin.js', 'dsh.exe', '/usr/bin/dsh']) assert.equal(followsHostCommand(value), false, value);
});

test('登记后解析和展示都用宿主内核，写了具体路径照旧；环境变量能传给子进程', () => {
  const l = layouts();
  const env = {};
  try {
    setHostDsh({ root: l.desktopRoot, version: '0.2.2-rc.5' }, { env });
    assert.equal(env[HOST_DSH_ENV], l.desktopRoot);
    assert.equal(resolveDshInstallRoot('dsh', l.root), l.desktopRoot);
    assert.equal(resolveDshInstallRoot('auto', l.root), l.desktopRoot);
    assert.equal(resolveDshInstallRoot(l.webEntry, l.root), l.webRoot, '具体路径不被覆盖');
    const runtime = inspectDshRuntime('dsh', l.root);
    assert.equal(runtime.mode, 'host');
    assert.equal(runtime.version, '0.2.2-rc.5');
    assert.match(runtime.detail, /跟随宿主 DSH 0\.2\.2-rc\.5/);

    // 子进程（独立模式的桥接）没有登记，只继承了环境变量
    setHostDsh(null, { env: null });
    assert.deepEqual(getHostDsh({ env }), { root: l.desktopRoot, version: '0.2.2-rc.5' });
    assert.equal(hostDshRootFor('dsh', { env }), l.desktopRoot);
    assert.equal(getHostDsh({ env: { [HOST_DSH_ENV]: 'relative/path' } }), null);
    assert.equal(getHostDsh({ env: { [HOST_DSH_ENV]: l.root } }), null, '不是 DSH 安装目录就不认');
  } finally {
    setHostDsh(null, { env });
    assert.equal(env[HOST_DSH_ENV], undefined);
    l.cleanup();
  }
});

test('内核模块认识改过名的包，都找不到时报原名的错', () => {
  const installed = new Set(['@deepseek-ai/dsh-deepseek-account', '@deepseek-ai/dsh-llm']);
  const requireDsh = {
    resolve(id) {
      if (installed.has(id)) return `/kernel/${id}/index.js`;
      throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' });
    },
  };
  assert.equal(resolveKernelModule(requireDsh, '@deepseek-ai/dsh-deepseek-account-platform'), '/kernel/@deepseek-ai/dsh-deepseek-account/index.js');
  assert.equal(resolveKernelModule(requireDsh, '@deepseek-ai/dsh-llm'), '/kernel/@deepseek-ai/dsh-llm/index.js');
  installed.add('@deepseek-ai/dsh-deepseek-account-platform');
  assert.equal(resolveKernelModule(requireDsh, '@deepseek-ai/dsh-deepseek-account-platform'), '/kernel/@deepseek-ai/dsh-deepseek-account-platform/index.js', '原名优先');
  assert.throws(() => resolveKernelModule(requireDsh, '@deepseek-ai/dsh-missing'), /dsh-missing/);
});
