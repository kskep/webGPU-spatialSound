# webGPU-spatialSound

Room acoustics simulation with WebGPU and binaural spatial audio, running entirely in the browser. Built as my Bachelor's thesis project.

**Live demo:** https://kskep.github.io/acoustic-webgpu/

<!-- Add a screenshot or GIF here, e.g. ![Screenshot](docs/screenshot.png) -->

## What it does

- Computes the acoustic response of a 3D room using WebGPU.
- Applies that response to a sound file (convolution), so you hear the sound as if it were played in the room.
- Outputs binaural audio, meant to be heard on headphones.
- Lets you walk around the room and place acoustic probes.

## Requirements

- **Node.js 24.x** and npm
- **Chrome or Edge** with WebGPU support and hardware acceleration enabled
- **Headphones**, to evaluate the binaural audio

## Getting started

```bash
npm install
npm run dev
```

The audio worklets are generated automatically before Vite starts.

## Usage

1. Wait until the page shows **WebGPU ready**, then click **Calculate Response**.
2. Under **Sound Files**, pick a sound or import your own.
3. Click **Play Convolved** to hear the sound with the room's response, or **Play Original** to hear the unprocessed sound.
4. Click **Stop Sound** to stop playback.
5. Click inside the room view to control the camera:
   - `W` `A` `S` `D` to move
   - `Space` / `C` to move up / down
   - Arrow keys or mouse drag to look around
6. Under **Probes**, add probes and bake them.

## Build

```bash
npm run build
npm run preview
```

## Project structure

| Path | Contents |
| --- | --- |
| `src/` | Application source code (TypeScript). See the [code guide](src/README.md). |
| `public/` | Static assets |
| `scripts/` | Build scripts, including audio worklet generation |
| `validation.html` | Validation page |
| `vite.config.ts` | Vite configuration |

## Tech stack

TypeScript, Vite, WebGPU, Web Audio API (AudioWorklets)

<!-- Optional: add a short "How it works" section here (how the room response is computed on the GPU, and one concrete result such as performance or accuracy). -->
