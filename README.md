# webGPU-spatialSound

Prosomoiwsi akoustikis dwmatiou me WebGPU kai binaural audio.

## Requirements

- **Node.js 24.x / npm**.
- **Chrome i Edge me WebGPU support** kai energopoihmeno hardware acceleration.
- **Akoustika** gia tin aksiologisi tou binaural audio.

## Ekkinisi

```bash
npm install
npm run dev
```

Ta audio-worklets paragontai automata prin ksekinisei o Vite.

## Xrisi

- Perimenw na grapsei **WebGPU ready** kai pataw **Calculate Response**.
- Apo **Sound Files** epilegw i kanw import ena sound.
- **Play Convolved** gia ixo me tin apokrisi tou dwmatiou, **Play Original** gia ton arxiko ixo xwris effects.
- **Stop Sound** gia na stamatisw.
- Klik sto dwmatio kai `WASD` gia kinisi, `Space/C` gia panw/katw, velakia i mouse drag gia na koitaksw gyrw.
- Sto **Probes** mporw na prosthesw kai na kanw bake probes.

## Build

```bash
npm run build
npm run preview
```

Perigrafes twn arxeiwn: [Odigos kodika](src/README.md).
