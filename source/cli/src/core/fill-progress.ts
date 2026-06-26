/**
 * source/cli/src/core/fill-progress.ts — progress tracking for `yg check --approve`.
 *
 * Handles two modes:
 *   - Non-TTY: milestone lines at thresholds + "still working" lines if no completion occurs
 *     for a configurable interval.
 *   - TTY: single line rewritten with \r on each event or timer tick.
 *
 * All dependencies on the environment (clock, TTY flag) are injectable for testability.
 * The caller (fill.ts) is responsible for setting up real timers and calling onTick().
 * Tests drive the tracker directly via onTick() with a fake clock — no real timers needed.
 */

// ============================================================
// Public types
// ============================================================

export interface ProgressOptions {
  isTTY: boolean;
  now: () => number;
  /** Milestone threshold: emit a milestone line every N completed pairs (non-TTY mode).
   *  Default: 25% of total, minimum 1. */
  milestoneInterval?: number;
  /** Still-working interval in milliseconds (non-TTY). If this many ms pass with no
   *  completion, emit a "still working" line. Default: 30000 (30s). */
  stillWorkingIntervalMs?: number;
}

export interface ProgressState {
  total: number;
  completed: number;
  approved: number;
  refused: number;
  infra: number;
  /** The aspect+unit of the most recently started (or in-progress) pair. */
  currentPair: string;
  lastCompletionTime: number;
}

// ============================================================
// ProgressTracker
// ============================================================

export class ProgressTracker {
  private readonly isTTY: boolean;
  private readonly now: () => number;
  private readonly milestoneInterval: number;
  private readonly stillWorkingIntervalMs: number;
  private readonly startTime: number;

  readonly state: ProgressState;

  constructor(total: number, opts: ProgressOptions) {
    this.isTTY = opts.isTTY;
    this.now = opts.now;
    this.stillWorkingIntervalMs = opts.stillWorkingIntervalMs ?? 30000;
    const startTime = opts.now();
    this.startTime = startTime;

    // milestoneInterval defaults to 25% of total, minimum 1
    this.milestoneInterval = opts.milestoneInterval ?? Math.max(1, Math.floor(total * 0.25));

    this.state = {
      total,
      completed: 0,
      approved: 0,
      refused: 0,
      infra: 0,
      currentPair: '',
      lastCompletionTime: startTime,
    };
  }

  /**
   * Called just before a pair starts filling. Updates currentPair and refreshes TTY display.
   */
  onPairStart(kind: 'det' | 'llm', aspectId: string, unitKey: string, write: (s: string) => void): void {
    this.state.currentPair = `${aspectId} on ${unitKey}`;
    if (this.isTTY) {
      this._writeTTYLine(write);
    }
  }

  /**
   * Called after a pair completes. Handles refused/approved/infra outcomes.
   * For refused/infra: emits an immediate line (these are actionable events, rare).
   * For approved: silently increments counter, checks milestone threshold (non-TTY).
   */
  onPairComplete(
    kind: 'det' | 'llm',
    aspectId: string,
    unitKey: string,
    verdict: string,
    write: (s: string) => void,
  ): void {
    this.state.completed += 1;
    this.state.lastCompletionTime = this.now();

    if (verdict === 'approved') {
      this.state.approved += 1;
    } else if (verdict === 'infra') {
      this.state.infra += 1;
    } else {
      // 'refused' or any unexpected verdict
      this.state.refused += 1;
    }

    if (this.isTTY) {
      // For refused/infra in TTY mode: clear the TTY line first, then emit the permanent line
      if (verdict !== 'approved') {
        write(`\r${' '.repeat(80)}\r`);
        write(`  [${kind}] ${aspectId} on ${unitKey} — ${verdict}\n`);
      }
      this._writeTTYLine(write);
    } else {
      // Non-TTY mode
      if (verdict !== 'approved') {
        // Refused/infra: immediate permanent line
        write(`  [${kind}] ${aspectId} on ${unitKey} — ${verdict}\n`);
      }
      // Milestone fires on every Nth completion regardless of verdict —
      // it shows overall progress (K/T filled + breakdown). A refused/infra
      // pair already got its own immediate line above, but the milestone
      // provides the aggregate view and is not a duplicate.
      if (this.state.completed % this.milestoneInterval === 0 && this.state.completed > 0) {
        this._writeMilestoneLine(write);
      }
    }
  }

  /**
   * Called periodically (by a setInterval in fill.ts, or directly in tests).
   * TTY mode: rewrites the status line.
   * Non-TTY mode: checks if still-working line should be emitted.
   */
  onTick(write: (s: string) => void): void {
    if (this.isTTY) {
      this._writeTTYLine(write);
    } else {
      this.isStillWorking(write);
    }
  }

  /**
   * For TTY mode: clears the rewritable progress line before the final report.
   * No-op in non-TTY mode.
   */
  clearLine(write: (s: string) => void): void {
    if (this.isTTY) {
      write(`\r${' '.repeat(80)}\r`);
    }
  }

  /**
   * For non-TTY mode: checks if a "still working" line should be emitted.
   * Emits if `now() - lastCompletionTime > stillWorkingIntervalMs`.
   * Returns true if emitted.
   */
  isStillWorking(write: (s: string) => void): boolean {
    if (this.isTTY) return false;
    const elapsed = this.now() - this.state.lastCompletionTime;
    if (elapsed > this.stillWorkingIntervalMs) {
      const { completed, total, currentPair } = this.state;
      write(`... still working (${completed}/${total}, waiting on ${currentPair})\n`);
      // Reset lastCompletionTime to avoid repeated still-working lines every tick
      this.state.lastCompletionTime = this.now();
      return true;
    }
    return false;
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private _writeTTYLine(write: (s: string) => void): void {
    const { completed, total, approved, refused, currentPair } = this.state;
    const elapsedSeconds = Math.floor((this.now() - this.startTime) / 1000);
    write(
      `filling... ${completed}/${total} · ok ${approved} · refused ${refused} · waiting on ${currentPair} (${elapsedSeconds}s)\r`,
    );
  }

  private _writeMilestoneLine(write: (s: string) => void): void {
    const { completed, total, approved, refused, infra } = this.state;
    const parts = [`${approved} ok`];
    if (refused > 0) parts.push(`${refused} refused`);
    if (infra > 0) parts.push(`${infra} infra`);
    write(`... ${completed}/${total} filled (${parts.join(', ')})\n`);
  }
}
