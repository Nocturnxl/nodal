// Checks the packaged build in dist/ (run after `npm run dist` or
// `npm run dist:dir`). The fuses switch off the debugging hooks that the
// end-to-end tests rely on, so the shipped binary is checked from outside:
//   1. the Electron fuses read back as specified,
//   2. the app starts, opens its database and logs that it is packaged,
//   3. it refuses to act as a plain Node runtime,
//   4. a tampered app.asar is rejected (ASAR integrity), where the platform supports it.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, openSync, closeSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const unpacked = {
  win32: ['dist/win-unpacked', 'Relay.exe', 'resources/app.asar'],
  linux: ['dist/linux-unpacked', 'relay', 'resources/app.asar'],
  darwin: ['dist/mac', 'Relay.app/Contents/MacOS/Relay', 'Relay.app/Contents/Resources/app.asar'],
}[process.platform];
const dir = join(root, unpacked[0]);
const exe = join(dir, unpacked[1]);
if (!existsSync(exe)) {
  console.error(`No packaged build at ${exe}. Run "npm run dist:dir" first.`);
  process.exit(2);
}

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (child) => {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
};
const temp = (name) => mkdtempSync(join(tmpdir(), `relay-verify-${name}-`));
const cleanup = [];

// 1. Fuses
const expected = {
  RunAsNode: 'Disabled',
  EnableNodeOptionsEnvironmentVariable: 'Disabled',
  EnableNodeCliInspectArguments: 'Disabled',
  OnlyLoadAppFromAsar: 'Enabled',
  EnableEmbeddedAsarIntegrityValidation: 'Enabled',
  GrantFileProtocolExtraPrivileges: 'Disabled',
};
const fuseCli = join(root, 'node_modules/@electron/fuses/dist/bin.js');
const fuseOut = execFileSync(process.execPath, [fuseCli, 'read', '--app', exe], { encoding: 'utf8' });
for (const [name, want] of Object.entries(expected)) {
  const got = new RegExp(`${name} is (\\w+)`).exec(fuseOut)?.[1];
  check(`fuse ${name} is ${want}`, got === want, got ? `read ${got}` : 'not found');
}

async function launch(exePath, env, waitFor, timeoutMs = 20000) {
  const child = spawn(exePath, [], { env: { ...process.env, ...env }, stdio: 'ignore' });
  let exited = null;
  child.on('exit', (code) => (exited = code ?? -1));
  const start = Date.now();
  let ok = false;
  while (Date.now() - start < timeoutMs && exited === null) {
    if (waitFor()) {
      ok = true;
      break;
    }
    await sleep(250);
  }
  return { child, ok: ok || waitFor(), exited };
}

// 2. Starts and opens its database
{
  const data = temp('start');
  cleanup.push(data);
  const log = join(data, 'logs', 'relay.log');
  const started = () => existsSync(log) && /INFO started .*"packaged":true/.test(readFileSync(log, 'utf8')) && existsSync(join(data, 'relay.db'));
  const run = await launch(exe, { RELAY_USER_DATA: data }, started);
  check('packaged app starts, opens its database and reports packaged=true', run.ok);
  killTree(run.child);
}

// 3. Not usable as a Node runtime
{
  const data = temp('node');
  cleanup.push(data);
  const marker = join(data, 'ran-as-node.txt');
  const child = spawn(exe, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', RELAY_USER_DATA: data },
    stdio: 'ignore',
  });
  await sleep(5000);
  check('ELECTRON_RUN_AS_NODE is ignored', !existsSync(marker));
  killTree(child);
}

// 4. ASAR integrity: flip one byte of app.asar in a copy of the build.
if (process.platform === 'win32' || process.platform === 'darwin') {
  const copy = temp('tamper');
  cleanup.push(copy);
  cpSync(dir, join(copy, 'app'), { recursive: true });
  const asar = join(copy, 'app', unpacked[2]);
  const fd = openSync(asar, 'r+');
  const buf = Buffer.alloc(1);
  // Inside the header region, which the embedded hash covers.
  readSync(fd, buf, 0, 1, 64);
  buf[0] ^= 0xff;
  writeSync(fd, buf, 0, 1, 64);
  closeSync(fd);
  const data = temp('tamper-data');
  cleanup.push(data);
  const log = join(data, 'logs', 'relay.log');
  const run = await launch(join(copy, 'app', unpacked[1]), { RELAY_USER_DATA: data }, () => existsSync(log), 12000);
  check('a tampered app.asar does not start', !run.ok, run.exited !== null ? `exited with ${run.exited}` : 'no start within 12 s');
  killTree(run.child);
} else {
  console.log('skip ASAR tamper check (integrity validation is not enforced on this platform)');
}

await sleep(1500);
for (const d of cleanup) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nPackaged build verified.');
