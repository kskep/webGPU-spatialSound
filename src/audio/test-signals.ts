// Sweep range and timing: an exponential sweep, then silence in which the modes ring out.
export const BASS_SWEEP = { startHz: 25, endHz: 200, sweepSeconds: 6, silenceSeconds: 1.5, amplitude: 0.5 };

export function bassSweepSamples(sampleRate: number, sweep = BASS_SWEEP): Float32Array {
  const { startHz, endHz, sweepSeconds, silenceSeconds, amplitude } = sweep;
  const data = new Float32Array(Math.round((sweepSeconds + silenceSeconds) * sampleRate));
  const rate = Math.log(endHz / startHz);
  const fade = 0.05;
  const count = Math.round(sweepSeconds * sampleRate);
  for (let i = 0; i < count; i++) {
    const time = i / sampleRate;
    const phase = ((2 * Math.PI * startHz * sweepSeconds) / rate) * (Math.exp((time * rate) / sweepSeconds) - 1);
    const edge = Math.min(time, sweepSeconds - time) / fade;
    const window = edge >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, edge));
    data[i] = amplitude * window * Math.sin(phase);
  }
  return data;
}
