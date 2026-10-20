// Run one trace at a time and keep only the newest waiting request.
// Auto mode picks a budget from listener speed and refines after motion stops.
// A fixed preset overrides that choice (the app uses settled-full).
// Scene revisions and request ids prevent outdated results from being applied.
import {
  AUTO_MODE_ID,
  AUTO_PRESET_IDS,
  QUALITY_PRESETS,
  SCHEDULER_SETTINGS,
  getQualityPreset,
  resolveBudget,
  type QualityPreset,
  type ResolvedBudget,
  type SchedulerSettings,
} from '../config/quality-presets.ts';
import type { StochasticSource } from '../config/probes.ts';

type Vec3 = [number, number, number];

// Opaque value returned by `setTimer`; only `clearTimer` needs to understand it.
export type TimerHandle = unknown;

// Time source and timers. The app uses the browser's; tests use a fake that they advance by hand.
export interface SchedulerClock {
  // Milliseconds on a monotonic clock.
  now(): number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

// The real clock: `performance.now()` and `setTimeout`.
export const browserClock: SchedulerClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// Why a trace was requested.
export type RequestReason =
  // The listener is moving.
  | 'motion'
  // The listener stopped for `settleDelayMs`.
  | 'settle'
  // The user pressed "Calculate".
  | 'manual'
  // A scene edit made the trace that was running obsolete.
  | 'scene-edit';

// One trace the scheduler has decided to run.
export interface TraceRequest {
  // Increasing id, starting at 1.
  id: number;
  reason: RequestReason;
  preset: QualityPreset;
  source: StochasticSource;
  // The numbers the trace must use (the preset applied to the GUI settings).
  budget: ResolvedBudget;
  // Scene revision when the request started; the result is stale if the scene moved on.
  revision: number;
  // Clock time in milliseconds when the trace started.
  startedAtMs: number;
}

// What happened to a finished request.
export type RequestOutcome = 'applied' | 'stale' | 'error';

// One line of the request history (shown in the debug panel, written to the export).
export interface RequestRecord {
  id: number;
  reason: RequestReason;
  presetId: string;
  // 'trace' or 'probes'.
  source: StochasticSource;
  rays: number;
  bounces: number;
  earlyOrder: number;
  revision: number;
  startedAtMs: number;
  outcome: RequestOutcome;
}

// Counters and the latest measurements, for the debug panel and the export.
export interface SchedulerStats {
  // 'auto' or the id of the forced preset.
  qualityMode: string;
  // Preset of the most recently started trace, or null before the first one.
  activePresetId: string | null;
  // Id of the most recently started trace (0 before the first one).
  lastRequestId: number;
  // Id of the most recently applied result (0 if none).
  lastAppliedId: number;
  started: number;
  applied: number;
  // Results thrown away because they were out of date.
  staleRejected: number;
  errors: number;
  // Waiting requests that were replaced by a newer one before they could start.
  queueReplaced: number;
  // Smoothed listener speeds from the last pose change.
  linearSpeed: number;
  angularSpeed: number;
  // How many traces each preset has run.
  presetCounts: Record<string, number>;
  // How many requests asked for each stochastic source.
  sourceCounts: Record<string, number>;
  // The most recent finished requests, oldest first.
  recent: RequestRecord[];
}

// What the scheduler needs from the application.
export interface SchedulerHooks<TResult> {
  // The GUI settings (ray count, bounces, early order) that presets with 'scene' fields follow.
  sceneBudget(): ResolvedBudget;
  // False while the GPU tracer does not exist yet; requests are dropped.
  isReady(): boolean;
  // A message if the scene cannot be traced right now (for example the camera is inside a box).
  blockedReason(): string | undefined;
  // Called with that message; the request is dropped and does not get an id.
  onBlocked(message: string): void;
  stochasticSource?(reason: RequestReason): StochasticSource;
  // Called when a trace starts.
  onStart(request: TraceRequest): void;
  // Runs the GPU trace.
  trace(request: TraceRequest): Promise<TResult>;
  // Called with the result of a trace that passed the stale check. May be asynchronous.
  apply(request: TraceRequest, result: TResult): void | Promise<void>;
  // Called when `trace` or `apply` throws.
  onError(request: TraceRequest, error: unknown): void;
  // Called after every request, whatever its outcome, once the scheduler is idle again.
  onFinish(request: TraceRequest, outcome: RequestOutcome): void;
}

// Optional replacements for the shipped tables, so tests can pass their own.
export interface SchedulerOptions {
  presets?: QualityPreset[];
  settings?: SchedulerSettings;
}

// A trace that has been asked for but not started yet.
interface PendingWant {
  reason: RequestReason;
}

// Listener speed

// Smoothed listener speeds.
export interface PoseSpeed {
  // Metres per second.
  linear: number;
  // Degrees per second (change of the viewing direction).
  angular: number;
}

// Angle in degrees between two direction vectors (they need not be normalised).
export function angleBetweenDegrees(a: Vec3, b: Vec3): number {
  const lengths = Math.hypot(...a) * Math.hypot(...b);
  if (lengths === 0) return 0;
  const cosine = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / lengths;
  // Rounding can push the cosine just outside [-1, 1], which would make acos return NaN.
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
}

export class PoseSpeedTracker {
  private previous: { timeMs: number; position: Vec3; forward: Vec3 } | undefined;
  private smoothed: PoseSpeed = { linear: 0, angular: 0 };
  // False until two poses have been seen, because a speed needs a previous pose.
  private measured = false;

  private readonly settings: SchedulerSettings;

  constructor(settings: SchedulerSettings) {
    this.settings = settings;
  }

  // Records a pose and returns the new smoothed speed.
  update(timeMs: number, position: Vec3, forward: Vec3): PoseSpeed {
    const previous = this.previous;
    this.previous = { timeMs, position: [...position], forward: [...forward] };
    if (!previous) return this.smoothed;

    // After a rest the whole movement is assumed to have happened in one nominal frame.
    const afterRest = timeMs - previous.timeMs > this.settings.movingWindowMs;
    const stepMs = afterRest ? this.settings.nominalPoseIntervalMs : timeMs - previous.timeMs;
    // EDW VRISKOUME TO XRONIKO VIMA GIA NA METRISOUME TAXYTITA KINISIS KAI STROFIS TOU LISTENER.
    const seconds = Math.max(stepMs, this.settings.minPoseIntervalMs) / 1000;

    const latest: PoseSpeed = {
      linear: Math.hypot(...position.map((value, axis) => value - previous.position[axis])) / seconds,
      angular: angleBetweenDegrees(previous.forward, forward) / seconds,
    };

    const weight = this.settings.speedSmoothing;
    if (afterRest || !this.measured) {
      this.smoothed = latest;
    } else {
      this.smoothed = {
        linear: weight * latest.linear + (1 - weight) * this.smoothed.linear,
        angular: weight * latest.angular + (1 - weight) * this.smoothed.angular,
      };
    }
    this.measured = true;
    return this.smoothed;
  }

  // The latest smoothed speed (zero before the second pose).
  get speed(): PoseSpeed {
    return this.smoothed;
  }

  // False before the second pose, when no speed could be computed yet.
  get hasMeasurement(): boolean {
    return this.measured;
  }
}

// The scheduler

export class AcousticScheduler<TResult> {
  private readonly presets: QualityPreset[];
  private readonly settings: SchedulerSettings;
  private readonly speedTracker: PoseSpeedTracker;
  private readonly clock: SchedulerClock;
  private readonly hooks: SchedulerHooks<TResult>;

  // 'auto', or the id of the preset the user forced.
  private mode = AUTO_MODE_ID;

  // Time of the last pose change, or undefined if the listener has not moved yet.
  private lastMotionMs: number | undefined;
  // Time the last trace was started, used for rate limiting.
  private lastStartMs = Number.NEGATIVE_INFINITY;

  private inFlight: TraceRequest | undefined;
  // The single waiting request. A newer request replaces it.
  private queued: PendingWant | undefined;

  // Fires the next motion-driven or delayed trace.
  private dispatchTimer: TimerHandle | undefined;
  // Fires the settled trace once the listener has stopped.
  private settleTimer: TimerHandle | undefined;

  private revision = 0;
  private nextRequestId = 1;
  private lastAppliedId = 0;
  private lastStartedPresetId: string | null = null;
  private counters = { started: 0, applied: 0, staleRejected: 0, errors: 0, queueReplaced: 0 };
  private presetCounts: Record<string, number> = {};
  private sourceCounts: Record<string, number> = {};
  private history: RequestRecord[] = [];

  constructor(clock: SchedulerClock, hooks: SchedulerHooks<TResult>, options: SchedulerOptions = {}) {
    this.clock = clock;
    this.hooks = hooks;
    this.presets = options.presets ?? QUALITY_PRESETS;
    this.settings = options.settings ?? SCHEDULER_SETTINGS;
    this.speedTracker = new PoseSpeedTracker(this.settings);
  }

  // Inputs from the application
  // True while a trace is running.
  get busy(): boolean {
    return this.inFlight !== undefined;
  }

  // Counts scene edits. A result is stale when this changed since its trace started.
  get sceneRevision(): number {
    return this.revision;
  }

  // 'auto', or the id of the forced preset.
  get qualityMode(): string {
    return this.mode;
  }

  // Chooses Auto or forces one preset (by id). Throws for an unknown id.
  setQualityMode(mode: string): void {
    if (mode !== AUTO_MODE_ID) getQualityPreset(mode, this.presets);
    this.mode = mode;
  }

  notifyPose(position: Vec3, forward: Vec3): void {
    const now = this.clock.now();
    this.lastMotionMs = now;
    this.speedTracker.update(now, position, forward);

    this.request({ reason: 'motion' });

    this.clock.clearTimer(this.settleTimer);
    this.settleTimer = this.clock.setTimer(() => {
      this.settleTimer = undefined;
      this.clock.clearTimer(this.dispatchTimer);
      this.dispatchTimer = undefined;
      this.request({ reason: 'settle' });
    }, this.settings.settleDelayMs);
  }

  // The user asked for a trace now (the "Calculate" button).
  requestTrace(): void {
    this.request({ reason: 'manual' });
  }

  invalidate(): void {
    this.revision++;
    this.clock.clearTimer(this.dispatchTimer);
    this.clock.clearTimer(this.settleTimer);
    this.dispatchTimer = undefined;
    this.settleTimer = undefined;
    this.queued = undefined;
  }

  // Cancels all timers (page is closing).
  dispose(): void {
    this.invalidate();
  }

  // Queries
  acceptsResult(requestId: number, revision: number): boolean {
    return requestId > this.lastAppliedId && revision === this.revision;
  }

  // Counters, speeds and recent history. The returned object is a copy.
  stats(): SchedulerStats {
    return {
      qualityMode: this.mode,
      activePresetId: this.lastStartedPresetId,
      lastRequestId: this.nextRequestId - 1,
      lastAppliedId: this.lastAppliedId,
      ...this.counters,
      linearSpeed: this.speedTracker.speed.linear,
      angularSpeed: this.speedTracker.speed.angular,
      presetCounts: { ...this.presetCounts },
      sourceCounts: { ...this.sourceCounts },
      recent: this.history.map((record) => ({ ...record })),
    };
  }

  // Choosing the preset
  // True while the last pose change is younger than `movingWindowMs`.
  isMoving(): boolean {
    return (
      this.lastMotionMs !== undefined && this.clock.now() - this.lastMotionMs < this.settings.movingWindowMs
    );
  }

  // Which preset a trace requested for `reason` would use right now.
  choosePreset(reason: RequestReason): QualityPreset {
    if (this.mode !== AUTO_MODE_ID) return getQualityPreset(this.mode, this.presets);

    const settled = getQualityPreset(AUTO_PRESET_IDS.settled, this.presets);
    if (reason !== 'motion' || !this.isMoving()) return settled;

    // Moving: fast motion gets the coarse preset, slow motion the refine one. Without a
    // measurement yet (the very first pose) the safe choice is the cheap coarse trace.
    const speed = this.speedTracker.speed;
    const fast =
      !this.speedTracker.hasMeasurement ||
      speed.linear >= this.settings.coarseLinearSpeed ||
      speed.angular >= this.settings.coarseAngularSpeed;
    return getQualityPreset(fast ? AUTO_PRESET_IDS.fast : AUTO_PRESET_IDS.slow, this.presets);
  }

  // Queue and dispatch
  // Entry point for every request: run it, delay it, or queue it behind the running trace.
  private request(want: PendingWant): void {
    if (this.inFlight) {
      // Serialise: only one trace at a time, and a newer request replaces the waiting one.
      if (this.queued) this.counters.queueReplaced++;
      this.queued = want;
      return;
    }
    this.scheduleStart(want);
  }

  // Delay before a request may start, so that its preset's minimum update interval is kept.
  private delayFor(want: PendingWant): number {
    if (want.reason === 'scene-edit') return this.settings.sceneEditDebounceMs;
    if (want.reason !== 'motion') return 0;
    const sinceLastStart = this.clock.now() - this.lastStartMs;
    return Math.max(0, this.choosePreset('motion').minUpdateIntervalMs - sinceLastStart);
  }

  // Starts the request now or after its delay.
  private scheduleStart(want: PendingWant): void {
    // Poses arrive every frame; one pending motion trace is enough, so later ones are absorbed.
    if (want.reason === 'motion' && this.dispatchTimer !== undefined) return;

    const delay = this.delayFor(want);
    const startImmediately = delay === 0 && want.reason !== 'motion';
    this.clock.clearTimer(this.dispatchTimer);
    this.dispatchTimer = undefined;
    if (startImmediately) {
      void this.start(want);
      return;
    }
    this.dispatchTimer = this.clock.setTimer(() => {
      this.dispatchTimer = undefined;
      void this.start(want);
    }, delay);
  }

  // Creates the request (id, preset, budget) and runs the trace.
  private async start(want: PendingWant): Promise<void> {
    if (this.inFlight) {
      // A timer fired while a trace was running: keep the request for when it finishes.
      this.queued = want;
      return;
    }
    this.lastStartMs = this.clock.now();
    if (!this.hooks.isReady()) return;

    const problem = this.hooks.blockedReason();
    if (problem) {
      this.hooks.onBlocked(problem);
      return;
    }

    const preset = this.choosePreset(want.reason);
    const source = this.hooks.stochasticSource?.(want.reason) ?? 'trace';
    const request: TraceRequest = {
      id: this.nextRequestId++,
      reason: want.reason,
      preset,
      source,
      budget: resolveBudget(preset, this.hooks.sceneBudget()),
      revision: this.revision,
      startedAtMs: this.lastStartMs,
    };
    this.inFlight = request;
    this.lastStartedPresetId = preset.id;
    this.counters.started++;
    this.presetCounts[preset.id] = (this.presetCounts[preset.id] ?? 0) + 1;
    this.sourceCounts[source] = (this.sourceCounts[source] ?? 0) + 1;
    this.hooks.onStart(request);

    let outcome: RequestOutcome;
    try {
      const result = await this.hooks.trace(request);
      if (this.acceptsResult(request.id, request.revision)) {
        this.lastAppliedId = request.id;
        await this.hooks.apply(request, result);
        this.counters.applied++;
        outcome = 'applied';
      } else {
        this.counters.staleRejected++;
        outcome = 'stale';
      }
    } catch (error) {
      this.counters.errors++;
      outcome = 'error';
      this.hooks.onError(request, error);
    }

    this.inFlight = undefined;
    this.remember(request, outcome);
    this.hooks.onFinish(request, outcome);
    this.startWaitingRequest(request);
  }

  // After a trace: start the waiting request, or retry after a scene edit made this result stale.
  private startWaitingRequest(finished: TraceRequest): void {
    const waiting = this.queued;
    this.queued = undefined;

    // A motion request that waited too long is dropped when the listener has stopped meanwhile:
    // the settle trace follows anyway.
    if (waiting && !(waiting.reason === 'motion' && !this.isMoving())) {
      this.scheduleStart(waiting);
      return;
    }
    if (finished.revision !== this.revision) {
      this.scheduleStart({ reason: 'scene-edit' });
    }
  }

  // Adds a finished request to the bounded history.
  private remember(request: TraceRequest, outcome: RequestOutcome): void {
    this.history.push({
      id: request.id,
      reason: request.reason,
      presetId: request.preset.id,
      source: request.source,
      rays: request.budget.rays,
      bounces: request.budget.bounces,
      earlyOrder: request.budget.earlyOrder,
      revision: request.revision,
      startedAtMs: request.startedAtMs,
      outcome,
    });
    if (this.history.length > this.settings.historyLength) this.history.shift();
  }
}
