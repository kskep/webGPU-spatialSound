// Full-quality traces update the room decay. Coarse traces reuse it to avoid
// audible changes in RT60 while moving. Scene edits clear the cache.
import type { TraceResult } from './model';
import type { LateDecay } from './decay-fit';

type DecayOrigin = 'full-trace' | 'provisional';

export class RoomDecayCache {
  private entry: { revision: number; decay: LateDecay; origin: DecayOrigin } | undefined;

  clear(): void {
    this.entry = undefined;
  }

  // Keep the trace's own fit for export. Use a coarse fit only until a full fit
  // is available for this scene revision.
  apply(trace: TraceResult, fullQuality: boolean, tracedRevision: number): void {
    const ownFit = trace.lateDecay;
    if (!ownFit) {
      return;
    }
    trace.lateDecayThisTrace = ownFit;

    let entry = this.entry;
    // EDW ANANEWNOUME TO DECAY MONO ME KALO TRACE I NEA SKINI GIA NA MIN TREMEI TO RT60 STIN KINISI.
    if (fullQuality || entry?.revision !== tracedRevision) {
      entry = {
        revision: tracedRevision,
        decay: ownFit,
        origin: fullQuality ? 'full-trace' : 'provisional',
      };
      this.entry = entry;
    }

    if (entry) {
      trace.lateDecay = entry.decay;
      trace.lateDecayOrigin = entry.origin;
    }
  }
}
