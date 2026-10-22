import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/bili_cookies.py');
const harness = String.raw`
import base64, hashlib, importlib.util, json, os, sqlite3, sys, tempfile
from pathlib import Path
helper, root, scenario = sys.argv[1:]
spec = importlib.util.spec_from_file_location('fixture_bili_cookies', helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = Path(root)
temporary = root / 'temporary'
temporary.mkdir()
tempfile.tempdir = str(temporary)
module.PROFILES = {browser: str(root / browser) for browser in ('edge', 'chrome')}
for browser in module.PROFILES:
    (root / browser).mkdir()
    (root / browser / 'Local State').write_text(json.dumps({'os_crypt': {'encrypted_key': base64.b64encode(b'DPAPIwrapped-key').decode()}}))

def dpapi(data):
    if data == b'wrapped-key': return bytes(range(32))
    if data.startswith(b'legacy:'): return data[7:]
    raise OSError('SECRET_DPAPI local private path')

class AES:
    def __init__(self, key):
        assert key == bytes(range(32))
    def decrypt(self, nonce, ciphertext, associated):
        assert nonce == b'n' * 12
        assert associated is None
        if scenario == 'decrypt_failed': raise OSError('SECRET_CRYPTO private key path')
        assert ciphertext.startswith(b'mock:')
        return ciphertext[5:-16]

module.dpapi_decrypt = dpapi
module.AESGCM = None if scenario == 'crypto_missing' else AES

def database(browser='edge', profile='Default', version=24, kind='aes', host='.bilibili.com'):
    directory = root / browser / profile / 'Network'
    directory.mkdir(parents=True)
    target = directory / 'Cookies'
    connection = sqlite3.connect(target)
    connection.execute('CREATE TABLE meta (key TEXT, value TEXT)')
    connection.execute('INSERT INTO meta VALUES (?, ?)', ('version', str(version)))
    connection.execute('CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, value TEXT)')
    for name, value in [('SESSDATA', 'fixture-session-secret'), ('bili_jct', 'fixture-csrf-secret')]:
        clear = (hashlib.sha256(host.encode()).digest() if version >= 24 else b'') + value.encode()
        if scenario == 'bad_host_hash': clear = b'x' * 32 + value.encode()
        if kind == 'aes': encrypted = b'v10' + b'n' * 12 + b'mock:' + clear + b't' * 16
        elif kind == 'v11': encrypted = b'v11' + b'n' * 12 + b'mock:' + clear + b't' * 16
        elif kind == 'legacy': encrypted = b'legacy:' + clear
        elif kind == 'v20': encrypted = b'v20' + b'x' * 40
        else: encrypted = b''
        connection.execute('INSERT INTO cookies VALUES (?, ?, ?, ?)', (host, name, encrypted, value if kind == 'plain' else ''))
    connection.commit()
    connection.close()
    return target

if scenario == 'no_fallback':
    database(browser='chrome', kind='plain')
    database(host='notbilibili.com', kind='plain')
elif scenario == 'secondary':
    database(host='bilibili.com.attacker.example', kind='plain')
    database(profile='Profile 1', kind='plain')
elif scenario == 'missing': pass
elif scenario == 'subdomain': database(kind='plain', host='api.bilibili.com')
elif scenario == 'bare_domain': database(kind='plain', host='bilibili.com')
elif scenario == 'legacy': database(kind='legacy')
elif scenario == 'aes23': database(version=23)
elif scenario == 'v11': database(kind='v11')
elif scenario == 'v20': database(kind='v20')
elif scenario == 'unreadable':
    target = database()
    target.write_bytes(b'PRIVATE DATABASE CONTENTS NOT SQLITE')
else: database()

if scenario == 'locked':
    def locked(*args, **kwargs):
        error = PermissionError(13, 'SECRET_PATH private database file')
        error.winerror = 32
        raise error
    module.shutil.copy2 = locked
elif scenario == 'sql_locked':
    def sql_locked(*args, **kwargs): raise sqlite3.OperationalError('database is locked SECRET_PATH')
    module.sqlite3.connect = sql_locked

sys.argv = [helper, 'edge', '--json']
sys.exit(module.main())
`;

async function runScenario(scenario) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-bili-cookie-test-'));
  try {
    const result = spawnSync(process.env.QQ_PYTHON || 'python', ['-c', harness, helper, root, scenario], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.stderr, '', 'helper failures must not emit raw exceptions, paths or credentials');
    assert.deepEqual(await fs.readdir(path.join(root, 'temporary')), [], 'temporary snapshots must always be removed');
    const payload = JSON.parse(result.stdout);
    return { status: result.status, payload, raw: result.stdout };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('selected browser never falls back to the other browser or matches lookalike domains', async () => {
  const result = await runScenario('no_fallback');
  assert.equal(result.status, 1);
  assert.deepEqual(result.payload, { error: 'bilibili_login_not_found' });
});

test('existing profiles remain supported within the explicitly selected browser', async () => {
  const result = await runScenario('secondary');
  assert.equal(result.status, 0);
  assert.equal(result.payload.profile, 'edge');
  assert.equal(result.payload.dir, 'Profile 1');
});

test('exact Bilibili domain and its subdomains are accepted', async () => {
  for (const scenario of ['bare_domain', 'subdomain']) assert.equal((await runScenario(scenario)).status, 0);
});

test('v10/v11 AES and legacy DPAPI support pre-v24 values and verified v24 host hashes', async () => {
  for (const scenario of ['aes24', 'aes23', 'v11', 'legacy']) {
    const result = await runScenario(scenario);
    assert.equal(result.status, 0, scenario);
    assert.equal(result.payload.cookies.SESSDATA, 'fixture-session-secret');
    assert.equal(result.payload.cookies.bili_jct, 'fixture-csrf-secret');
  }
});

for (const [scenario, code] of [
  ['v20', 'cookie_app_bound_unsupported'], ['locked', 'cookie_database_locked'],
  ['sql_locked', 'cookie_database_locked'], ['missing', 'browser_profile_not_found'],
  ['unreadable', 'cookie_database_unreadable'], ['crypto_missing', 'cookie_crypto_unavailable'],
  ['bad_host_hash', 'cookie_decryption_failed'], ['decrypt_failed', 'cookie_decryption_failed'],
]) {
  test(`${scenario} produces a fixed safe JSON error and cleans its snapshot`, async () => {
    const result = await runScenario(scenario);
    assert.equal(result.status, 1);
    assert.deepEqual(result.payload, { error: code });
    assert.doesNotMatch(result.raw, /SECRET_|fixture-session|fixture-csrf|PRIVATE|[A-Z]:\\/);
  });
}
