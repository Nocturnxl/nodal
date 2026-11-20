import { describe, expect, it } from 'vitest';
import { AutoLock, type LockReason } from '../../src/main/secrets/autolock';
import { Vault } from '../../src/main/secrets/vault';
import { cleanupTmp, tmpDir } from './helpers';

const MIN = 60_000;

function rig(minutes = 5) {
  const state = { now: 1_000_000, minutes, busy: false, locks: [] as LockReason[] };
  const auto = new AutoLock({
    minutes: () => state.minutes,
    busy: () => state.busy,
    lock: (reason) => state.locks.push(reason),
    now: () => state.now,
  });
  const advance = (ms: number) => {
    state.now += ms;
    auto.check();
  };
  return { state, auto, advance };
}

describe('auto-lock', () => {
  it('locks after the chosen time without input, and not before', () => {
    const { state, advance } = rig(5);
    advance(5 * MIN - 1);
    expect(state.locks).toEqual([]);
    advance(1);
    expect(state.locks).toEqual(['idle']);
  });

  it('input restarts the clock', () => {
    const { state, auto, advance } = rig(5);
    advance(4 * MIN);
    auto.touch();
    advance(4 * MIN);
    expect(state.locks).toEqual([]);
    advance(MIN);
    expect(state.locks).toEqual(['idle']);
  });

  it('never locks when set to 0, when encryption is off, or when already locked', () => {
    const { state, auto, advance } = rig(0);
    advance(24 * 60 * MIN);
    auto.request('screen');
    expect(state.locks).toEqual([]);
    // Time spent with it off does not count once it is turned on.
    state.minutes = 5;
    advance(4 * MIN);
    expect(state.locks).toEqual([]);
    advance(MIN);
    expect(state.locks).toEqual(['idle']);
  });

  it('does not cut off a reply: the idle time starts when it finishes', () => {
    const { state, advance } = rig(1);
    state.busy = true;
    advance(10 * MIN);
    expect(state.locks).toEqual([]);
    state.busy = false;
    advance(MIN - 1);
    expect(state.locks).toEqual([]);
    advance(1);
    expect(state.locks).toEqual(['idle']);
  });

  it('locks at once when the computer is locked or sleeps', () => {
    const { state, auto } = rig(60);
    auto.request('screen');
    expect(state.locks).toEqual(['screen']);
  });

  it('a screen lock during a reply locks as soon as the reply is done', () => {
    const { state, auto, advance } = rig(60);
    state.busy = true;
    auto.request('sleep');
    advance(5000);
    expect(state.locks).toEqual([]);
    state.busy = false;
    advance(5000);
    expect(state.locks).toEqual(['sleep']);
    // One request locks once.
    advance(5000);
    expect(state.locks).toEqual(['sleep']);
  });

  it('starts counting afresh after a lock', () => {
    const { state, advance } = rig(1);
    advance(MIN);
    advance(MIN - 1);
    expect(state.locks).toEqual(['idle']);
    advance(1);
    expect(state.locks).toEqual(['idle', 'idle']);
  });
});

describe('locking the vault', () => {
  it('forgets the key until the passphrase is given again', async () => {
    const vault = new Vault(tmpDir(), { N: 1 << 10, r: 8, p: 1 });
    const keys = await vault.create('correct horse battery staple');
    vault.lock();
    expect(vault.enabled).toBe(true);
    expect(vault.unlocked).toBe(false);
    expect(vault.keys).toBeNull();
    expect(await vault.verify('correct horse battery staple')).toBe(false);
    expect(await vault.changePassphrase('correct horse battery staple', 'another four random words')).toBe(false);
    expect(await vault.unlock('not the passphrase')).toBeNull();
    expect(vault.unlocked).toBe(false);
    expect((await vault.unlock('correct horse battery staple'))?.db).toBe(keys.db);
    cleanupTmp();
  });
});
