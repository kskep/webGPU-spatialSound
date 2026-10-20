// Playback, sound loading and volume.
import { AudioPreview } from '../audio/preview';
import type { LateDecayMode } from '../audio/hybrid-response';
import { DEFAULT_RENDER_MODE_ID } from '../config/render-modes';
import type { AudioUpdateTimings } from '../app/stage-timings';
import type { Scene } from '../acoustics/model';
import type { AppTraceResult } from '../gpu/trace-types';

// Name of the built-in test pulse in the "Select Sound" dropdown.
const BUILT_IN_PULSE = 'Built-in pulse';
// Name of the built-in low-frequency sweep, for listening to the room modes.
const BASS_SWEEP = 'Bass sweep';

// What the controller needs from the application.
export interface PlaybackContext {
  getScene(): Scene;
  getResult(): AppTraceResult | undefined;
  status(message: string, error?: boolean): void;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class PlaybackController {
  readonly audio = new AudioPreview();
  // True while the convolved sound is playing.
  playing = false;

  private context: PlaybackContext;

  constructor(context: PlaybackContext) {
    this.context = context;
  }

  selectedLateDecayMode(): LateDecayMode {
    return 'ray-fit';
  }

  // Stops playback and disables the Stop button.
  stop(): void {
    this.playing = false;
    this.audio.stop();
    byId<HTMLButtonElement>('stop').disabled = true;
  }

  selectedRenderModeId(): string {
    return DEFAULT_RENDER_MODE_ID;
  }

  // Rebuilds the room response for a new trace result, if the sound is playing; returns its timings.
  async refreshIfPlaying(scene: Scene, result: AppTraceResult): Promise<AudioUpdateTimings | undefined> {
    if (!this.playing) return undefined;
    return this.audio.play(scene, result);
  }

  // Connects the DOM controls to the audio engine.
  bind(): void {
    const { audio, context } = this;

    byId('play').addEventListener('click', async () => {
      const result = context.getResult();
      if (!result) return;
      try {
        await audio.play(context.getScene(), result);
        const playback = audio.telemetry();
        this.playing = playback.playing && playback.playbackMode === 'convolved';
        byId<HTMLButtonElement>('stop').disabled = !playback.playing;
        if (this.playing)
          context.status('Playing measured-HRTF binaural audio with eight-band room reflections.');
      } catch (error) {
        context.status((error as Error).message, true);
      }
    });

    byId('play-original').addEventListener('click', async () => {
      this.playing = false;
      try {
        await audio.playOriginal();
        const playback = audio.telemetry();
        byId<HTMLButtonElement>('stop').disabled = !playback.playing;
        if (playback.playing && playback.playbackMode === 'original') {
          context.status('Playing original sound without the room response.');
        }
      } catch (error) {
        this.stop();
        context.status((error as Error).message, true);
      }
    });

    byId('stop').addEventListener('click', () => {
      this.stop();
      context.status('Audio stopped.');
    });

    byId('audio-file').addEventListener('change', async () => {
      const file = byId<HTMLInputElement>('audio-file').files?.[0];
      if (!file) return;
      try {
        this.stop();
        if (!(await audio.load(file))) return;
        byId('audio-name').textContent = file.name;
        window.dispatchEvent(new Event('audio-imported'));
        context.status('Audio loaded. Play preview to hear it in this room.');
      } catch (error) {
        context.status(`Could not decode audio: ${(error as Error).message}`, true);
      }
    });

    window.addEventListener('master-volume', (event) =>
      audio.setVolume((event as CustomEvent<number>).detail),
    );
    window.addEventListener('source-level', (event) =>
      audio.setSourceLevel((event as CustomEvent<number>).detail),
    );

    window.addEventListener('sound-choice', async (event) => {
      const name = (event as CustomEvent<string>).detail;
      this.stop();
      if (name === BUILT_IN_PULSE) {
        audio.useTestSignal();
        byId('audio-name').textContent = name;
        context.status('Built-in pulse selected.');
        return;
      }
      if (name === BASS_SWEEP) {
        audio.useTestSignal('sweep');
        byId('audio-name').textContent = name;
        context.status(
          'Bass sweep selected: 25-200 Hz over 6 s, then 1.5 s of silence for the modes to ring.',
        );
        return;
      }
      try {
        const response = await fetch('/soundfile/' + encodeURIComponent(name));
        if (!response.ok) throw new Error('Sound file could not be loaded.');
        const file = new File([await response.blob()], name, { type: 'audio/mpeg' });
        if (!(await audio.load(file))) return;
        byId('audio-name').textContent = name;
        context.status('Sound loaded: ' + name);
      } catch (error) {
        context.status((error as Error).message, true);
      }
    });
  }
}
