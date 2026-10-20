// BRAS CR2 listening comparison: measured response, simulated response, or dry sound.
// Measured files load from the local /external-bras/ route and are not bundled.
// Simulation uses the same pose, all binaural options and the full-IR renderer.
import { BRAS_CR2_BINAURAL_POSES, BRAS_CR2_FILES, BRAS_CR2_FOLDER } from '../config/bras-cr2.ts';
import { defaultBinauralToggles } from '../config/binaural.ts';
import { HrtfBank } from '../audio/hrtf.ts';
import { MeshTracer } from '../gpu/mesh-tracer.ts';
import { PreparedSceneCache } from '../gpu/prepared-scene.ts';
import { brasScene, fullImpulseResponse, traceScene } from './bras-simulation.ts';

// URL prefix of the dev-only route to external/bras (vite.config.ts).
const EXTERNAL_ROUTE = '/external-bras/';
// Sampling rate of the measured responses and of the audio context.
const SAMPLE_RATE = 44100;
// Crossfade between the paths, in seconds.
const CROSSFADE_SECONDS = 0.03;
// Output level of every path, a margin against clipping.
const MASTER_GAIN = 0.35;

type Path = 'measured' | 'simulated' | 'dry';

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = (text: string) => (byId('status').textContent = text);
const checked = (name: string): string =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)!.value;

// Energy of a stereo response averaged over the two ears: the sum of the squared samples divided by two.
function responseEnergy(buffer: AudioBuffer): number {
  let sum = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    for (const value of buffer.getChannelData(channel)) sum += value * value;
  }
  return sum / buffer.numberOfChannels;
}

// The three paths of the player and what is currently playing.
class Player {
  private readonly context = new AudioContext({ sampleRate: SAMPLE_RATE });
  private readonly gains: Record<Path, GainNode>;
  private source: AudioBufferSourceNode | undefined;
  private active: Path = 'measured';
  private convolvers: ConvolverNode[] = [];
  playing = false;

  constructor() {
    const master = this.context.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(this.context.destination);
    this.gains = {
      measured: this.context.createGain(),
      simulated: this.context.createGain(),
      dry: this.context.createGain(),
    };
    for (const gain of Object.values(this.gains)) {
      gain.gain.value = 0;
      gain.connect(master);
    }
    this.gains[this.active].gain.value = 1;
  }

  async decode(url: string): Promise<AudioBuffer> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} could not be loaded (${response.status}).`);
    return this.context.decodeAudioData(await response.arrayBuffer());
  }

  makeBuffer(left: Float32Array, right: Float32Array): AudioBuffer {
    const buffer = this.context.createBuffer(2, left.length, SAMPLE_RATE);
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);
    return buffer;
  }

  // Starts the looped sound through the three paths. `responses` are scaled to unit energy here.
  start(sound: AudioBuffer, responses: { measured: AudioBuffer; simulated: AudioBuffer }): void {
    this.stop();
    this.source = this.context.createBufferSource();
    this.source.buffer = sound;
    this.source.loop = true;
    this.convolvers = (['measured', 'simulated'] as const).map((path) => {
      const convolver = this.context.createConvolver();
      convolver.normalize = false;
      convolver.buffer = responses[path];
      // Equal broadband response energy for equal loudness.
      const scale = this.context.createGain();
      scale.gain.value = 1 / Math.sqrt(responseEnergy(responses[path]));
      this.source!.connect(convolver);
      convolver.connect(scale);
      scale.connect(this.gains[path]);
      return convolver;
    });
    this.source.connect(this.gains.dry);
    void this.context.resume();
    this.source.start();
    this.playing = true;
  }

  stop(): void {
    this.source?.stop();
    this.source?.disconnect();
    this.convolvers.forEach((convolver) => convolver.disconnect());
    this.source = undefined;
    this.convolvers = [];
    this.playing = false;
  }

  // Crossfades to `path`.
  select(path: Path): void {
    const now = this.context.currentTime;
    for (const [name, gain] of Object.entries(this.gains) as [Path, GainNode][]) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(name === path ? 1 : 0, now + CROSSFADE_SECONDS);
    }
    this.active = path;
  }

  get selected(): Path {
    return this.active;
  }
}

const player = new Player();
let responses: { measured: AudioBuffer; simulated: AudioBuffer; sound: AudioBuffer } | undefined;
let tracer: MeshTracer | undefined;
const cache = new PreparedSceneCache();
let hrtf: HrtfBank | undefined;

// Fetches the measured response and simulates the app's, for the chosen loudspeaker.
async function loadResponses(): Promise<void> {
  const loudspeaker = Number(checked('ls'));
  const pose = BRAS_CR2_BINAURAL_POSES;
  const source = pose.sources[loudspeaker - 3];

  status(`Fetching the measured response of LS${loudspeaker} ...`);
  const wav = await player.decode(
    `${EXTERNAL_ROUTE}${encodeURI(`${BRAS_CR2_FOLDER}/${BRAS_CR2_FILES.brir(loudspeaker)}`)}`,
  );
  if (wav.numberOfChannels !== 2) throw new Error('The measured response is not stereo.');

  status('Simulating the same loudspeaker and head position with the app ...');
  tracer ??= await MeshTracer.create((message) => status('GPU: ' + message));
  hrtf ??= new HrtfBank(await (await fetch('/hrtf/RIEC_hrir_subject_080.bin')).arrayBuffer());
  const toggles = defaultBinauralToggles();
  hrtf.prepare(toggles);
  const scene = brasScene({
    source: source.position,
    receiver: pose.receiver.position,
    headForward: pose.headForward,
  });
  const result = await traceScene(tracer, cache, scene);
  const simulated = fullImpulseResponse(scene, result, SAMPLE_RATE, hrtf, toggles);

  status('Decoding the sound ...');
  const sound = await player.decode(checked('sound'));
  responses = { measured: wav, simulated: player.makeBuffer(simulated.left, simulated.right), sound };

  const decibels = (ratio: number) => (10 * Math.log10(ratio)).toFixed(1);
  byId('numbers').textContent =
    `Response energy before level matching: measured ${responseEnergy(wav).toExponential(2)}, simulated ` +
    `${responseEnergy(responses.simulated).toExponential(2)} (simulated minus measured ${decibels(
      responseEnergy(responses.simulated) / responseEnergy(wav),
    )} dB, removed by the level matching). Lengths: measured ${(wav.length / SAMPLE_RATE).toFixed(2)} s, simulated ${(
      responses.simulated.length / SAMPLE_RATE
    ).toFixed(2)} s.`;
  for (const id of ['play', 'a', 'b', 'dry']) byId<HTMLButtonElement>(id).disabled = false;
  status(`Ready: LS${loudspeaker}. Press "Play / stop", then switch with A, B and D.`);
}

function showSelected(): void {
  byId('a').classList.toggle('on', player.selected === 'measured');
  byId('b').classList.toggle('on', player.selected === 'simulated');
  byId('dry').classList.toggle('on', player.selected === 'dry');
}

function choose(path: Path): void {
  player.select(path);
  showSelected();
}

function toggleSound(): void {
  if (!responses) return;
  if (player.playing) player.stop();
  else player.start(responses.sound, responses);
  byId('play').classList.toggle('on', player.playing);
}

byId('load').addEventListener('click', () => {
  player.stop();
  byId('play').classList.remove('on');
  loadResponses().catch((error: Error) =>
    status(
      `${error.message} This page needs the dev server (npm run dev) and the BRAS data in external/bras, and WebGPU.`,
    ),
  );
});
byId('play').addEventListener('click', toggleSound);
byId('a').addEventListener('click', () => choose('measured'));
byId('b').addEventListener('click', () => choose('simulated'));
byId('dry').addEventListener('click', () => choose('dry'));
window.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (!responses) return;
  if (key === 'a') choose('measured');
  else if (key === 'b') choose('simulated');
  else if (key === 'd') choose('dry');
  else if (key === ' ') {
    event.preventDefault();
    toggleSound();
  }
});
showSelected();
