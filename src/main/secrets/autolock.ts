export type LockReason = 'idle' | 'screen' | 'sleep' | 'manual';

export interface AutoLockDeps {
  /** Minutes of inactivity before locking. 0 (or less) means never: also when encryption is off or already locked. */
  minutes(): number;
  /** True while a reply is streaming. Locking waits for it. */
  busy(): boolean;
  lock(reason: LockReason): void;
  now?(): number;
}

/**
 * Decides when an unlocked, encrypted profile should lock itself: after the
 * chosen time without keyboard or mouse input in NODAL, or when the computer
 * is locked. A reply that is still arriving counts as activity, so NODAL never
 * cuts one off; it locks once the reply has finished.
 */
export class AutoLock {
  private last: number;
  private pending: LockReason | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: AutoLockDeps) {
    this.now = deps.now ?? Date.now;
    this.last = this.now();
  }

  /** The user did something in the window. */
  touch(): void {
    this.last = this.now();
  }

  /** Starts the idle clock afresh, for example right after unlocking. */
  reset(): void {
    this.last = this.now();
    this.pending = null;
  }

  /** The computer was locked: lock as soon as no reply is streaming. */
  request(reason: LockReason): void {
    if (this.deps.minutes() <= 0) return;
    this.pending = reason;
    this.check();
  }

  /** Called on a timer. */
  check(): void {
    const minutes = this.deps.minutes();
    if (minutes <= 0) {
      this.reset();
      return;
    }
    if (this.deps.busy()) {
      this.last = this.now();
      return;
    }
    const reason = this.pending ?? (this.now() - this.last >= minutes * 60_000 ? 'idle' : null);
    if (!reason) return;
    this.reset();
    this.deps.lock(reason);
  }
}
