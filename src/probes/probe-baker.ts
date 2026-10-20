// Trace each probe position, store its compressed stochastic field and decay fit.
// Pause between batches so input and drawing can continue. Cancellation or changed
// scene/source keys discard an unfinished bake; completed probes report progress.
import type { Arrival, Vec3 } from '../acoustics/model.ts';
import type { LateDecay } from '../acoustics/decay-fit.ts';
import { PROBE_CONFIG, type ProbeConfig } from '../config/probes.ts';
import { compressStochastic, type ProbeBake } from './probe-data.ts';
import type { Probe } from './probe-set.ts';

// What tracing at one position returns. Only the stochastic part is needed.
export interface ProbeTraceOutput {
  arrivals: Arrival[];
  lateDecay?: LateDecay;
  rays: number;
  bounces: number;
  // Milliseconds of the trace itself.
  traceMs: number;
  seed: number;
  earlyOrder: number;
  presetId: string;
}

// What the baker needs from the application.
export interface BakeDeps {
  // Traces the stochastic field with the listener at `position`.
  traceAt(position: Vec3): Promise<ProbeTraceOutput>;
  // Why this probe may not be baked right now (position no longer valid), or undefined.
  placementProblem?(probe: Probe): string | undefined;
  // False once the scene or the source changed since the bake started.
  keysCurrent(): boolean;
  now(): number;
  // Gives the page a chance to draw and handle input.
  pause(): Promise<void>;
}

// Progress after one probe.
export interface BakeProgress {
  done: number;
  total: number;
  // Id of the probe that was just handled.
  probeId: string;
  elapsedMs: number;
}

export interface BakeOptions {
  config?: ProbeConfig;
  signal?: AbortSignal;
  onProgress?(progress: BakeProgress): void;
  onBaked?(probeId: string, bake: ProbeBake): void;
}

// What a bake run did.
export interface BakeSummary {
  baked: string[];
  failed: { id: string; message: string }[];
  // True when the run stopped early: cancelled or the scene changed.
  cancelled: boolean;
  // Why it stopped early.
  stopReason?: 'cancelled' | 'scene-changed';
  totalMs: number;
  // Bake time of each baked probe in milliseconds (trace plus compression), in order.
  perProbeMs: number[];
}

// Bakes `probes` in order. See the file comment.
export async function bakeProbes(
  probes: Probe[],
  deps: BakeDeps,
  options: BakeOptions = {},
): Promise<BakeSummary> {
  const config = options.config ?? PROBE_CONFIG;
  const started = deps.now();
  const summary: BakeSummary = { baked: [], failed: [], cancelled: false, totalMs: 0, perProbeMs: [] };
  const stop = (reason: 'cancelled' | 'scene-changed'): BakeSummary => {
    summary.cancelled = true;
    summary.stopReason = reason;
    summary.totalMs = deps.now() - started;
    return summary;
  };

  for (let index = 0; index < probes.length; index++) {
    const probe = probes[index];
    if (options.signal?.aborted) return stop('cancelled');
    if (!deps.keysCurrent()) return stop('scene-changed');

    const problem = deps.placementProblem?.(probe);
    if (problem) {
      summary.failed.push({ id: probe.id, message: problem });
    } else {
      try {
        const probeStarted = deps.now();
        const trace = await deps.traceAt(probe.position);
        // The trace is thrown away when the bake was cancelled, or the scene changed, meanwhile.
        if (options.signal?.aborted) return stop('cancelled');
        if (!deps.keysCurrent()) return stop('scene-changed');
        const data = compressStochastic(trace.arrivals, {
          binSetId: config.directionBinSetId,
          timeBinSeconds: config.timeBinMs / 1000,
        });
        const bake: ProbeBake = {
          data,
          lateDecay: trace.lateDecay,
          bakeMs: deps.now() - probeStarted,
          traceMs: trace.traceMs,
          rays: trace.rays,
          bounces: trace.bounces,
          presetId: trace.presetId,
          seed: trace.seed,
          earlyOrder: trace.earlyOrder,
        };
        summary.baked.push(probe.id);
        summary.perProbeMs.push(bake.bakeMs);
        options.onBaked?.(probe.id, bake);
      } catch (error) {
        summary.failed.push({ id: probe.id, message: (error as Error).message });
      }
    }
    options.onProgress?.({
      done: index + 1,
      total: probes.length,
      probeId: probe.id,
      elapsedMs: deps.now() - started,
    });
    if ((index + 1) % config.bakeBatchSize === 0 && index + 1 < probes.length) await deps.pause();
  }
  summary.totalMs = deps.now() - started;
  return summary;
}
