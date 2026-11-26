/**
 * link-install-test.mjs —— DSH 用 GitHub 链接安装本仓库时需要的东西。
 *
 * DSH 把链接交给 pnpm，然后读仓库根目录 package.json 的 dsh.bundle。
 * 这里检查根清单能被识别为组合包，以及装进 pnpm 目录后配置放在 ~/.dsh/qq-bridge。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCompanionConfig, INSTALLED_DATA_DIRNAME } from '../src/companion/lib/console-mount.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const patchRel = pkg?.dsh?.bundle?.patch;
check('root package.json declares dsh.bundle.patch', typeof patchRel === 'string' && patchRel.length > 0);
const patchPath = path.resolve(ROOT, String(patchRel));
check('bundle patch file exists', fs.existsSync(patchPath));
const patchText = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
check('bundle patch loads the package by its own name', new RegExp(`^\\s*name:\\s*${pkg.name}\\s*$`, 'm').test(patchText));
check('bundle patch keeps the companion plugin id', /^\s*-\s*id:\s*qq-bridge-companion\s*$/m.test(patchText));
check('main entry exists', fs.existsSync(path.join(ROOT, pkg.main)));
check('client export exists', fs.existsSync(path.join(ROOT, pkg.exports['./client'])));
check('package name stays qq-bridge for the portable updater', pkg.name === 'qq-bridge');

const files = Array.isArray(pkg.files) ? pkg.files : [];
const shipped = (rel) => files.some((entry) => rel === entry.replace(/\/$/, '') || rel.startsWith(entry.endsWith('/') ? entry : `${entry}/`));
for (const rel of [path.relative(ROOT, patchPath).replaceAll('\\', '/'), pkg.main, 'config.example.json', 'runtime/astrbot-lock.json', 'tools/imagegen.mjs']) {
  check(`files ships ${rel}`, shipped(rel));
}

const codeRoot = path.join(ROOT, 'fixture-code');
const dshHome = path.join(ROOT, 'fixture-home');
const existsOnly = (...present) => (target) => present.includes(path.resolve(target));

const clone = resolveCompanionConfig({ codeRoot, dshHome, exists: existsOnly(path.join(codeRoot, '.git')) });
check('git clone keeps config.json next to the code', clone.path === path.join(codeRoot, 'config.json') && !clone.installed && !clone.explicit);

const portable = resolveCompanionConfig({ codeRoot, dshHome, exists: existsOnly(path.join(codeRoot, 'config.json')) });
check('existing config.json stays in place', portable.path === path.join(codeRoot, 'config.json') && !portable.installed);

const installed = resolveCompanionConfig({ codeRoot, dshHome, exists: existsOnly() });
check('link install moves config under the DSH home',
  installed.path === path.join(dshHome, INSTALLED_DATA_DIRNAME, 'config.json') && installed.installed && installed.explicit);

const requested = resolveCompanionConfig({ codeRoot, dshHome, requestedConfig: 'custom/cfg.json', exists: existsOnly() });
check('explicit configFile wins', requested.path === path.join(codeRoot, 'custom', 'cfg.json') && !requested.installed && requested.explicit);

console.log(`${passed}/${passed + failed} link install checks passed`);
if (failed) process.exitCode = 1;
