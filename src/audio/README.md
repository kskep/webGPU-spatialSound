# audio

Edw metatrepw ta apotelesmata tis prosomoiwsis se stereo ixo. To app xrisimopoiei hybrid rendering, enw to full-IR paramenei gia sygkriseis.

## Arxeia

- [band-noise.ts](band-noise.ts): Ftiaxnw seeded noise ana octave band kai to prosarmozw sto energy envelope. To seed epitrepei na pairnw to idio noise stis idies synthikes.
- [full-ir-response.ts](full-ir-response.ts): Ftiaxnw ena plires stereo impulse response me early reflections, traced meros kai synthetic tail apo to decay fit. Afto paizei me convolution, xwris late FDN.
- [hrtf-processing.ts](hrtf-processing.ts): Exw ta DSP voithitika gia ta HRTF: minimum-phase spectrum, smoothing, ektimisi kathysterisis kai fractional delays gia swsto interpolation.
- [hrtf.ts](hrtf.ts): Fortwnw kai diaxeirizomai ta metrimena HRIR. Epilegw i kanw interpolation gia mia katefthynsi kai efarmozw diffuse-field EQ otan einai energopoihmeno.
- [hybrid-response.ts](hybrid-response.ts): Ftiaxnw to early FIR kai tis rythmiseis tou late FDN. Orizw pou ginetai i syndesi tous kai poio decay tha xrisimopoiithei ana banda.
- [ir-synthesis.ts](ir-synthesis.ts): Metatrepw tis afikseis se impulse response me per-band filtering kai delays. Exw episis ti synthesi tou panned stochastic merous.
- [ir-worker.ts](ir-worker.ts): Trexw tin kataskevi tis audio apokrisis se Web Worker gia na min varetai to UI thread. Epistrefw ta buffers kai tous xronous ypologismou.
- [late-level.ts](late-level.ts): Ektimw ti stathmi tou late merous se ena xroniko parathyro apo ta hits kai ti thewria. Tin xrisimopoiw gia to gain tou FDN i tou synthetic tail.
- [preview.ts](preview.ts): Diaxeirizomai Web Audio, fortwsi ixou, worker kai AudioWorklet. Exw kai direct playback tou arxikou ixou xwris room processing, me koino master volume.
- [room-response.ts](room-response.ts): Epilegw poios builder tha trexei: hybrid i full-IR. Pernaw tis koines rythmiseis kai epistrefw tin apokrisi gia to audio.
- [sphere-mesh.ts](sphere-mesh.ts): Ftiaxnw triangulation twn HRTF katefthynsewn panw sti monadiaia sfaira. To xrisimopoiw gia interpolation kai varia me vasi ti sterea gwnia.
- [stochastic-binaural.ts](stochastic-binaural.ts): Moirazw to stochastic pedio se direction bins kai pernaw ton ixo kathe bin apo ta antistoixa left/right HRIR. Etsi dinei katefthynsi kai sta dyo aftia.
- [tail-noise.ts](tail-noise.ts): Ftiaxnw band-limited noise pou svinei me to RT60 kathe bandas. Einai to synthetic late tail tou full-IR renderer.
- [test-signals.ts](test-signals.ts): Edw ftiaxnw to bass sweep pou xrisimopoiw gia akroasi xwris ekswteriko arxeio. Meta to sweep afhnw siwpi gia na akougetai to svhsimo.

## Ypofakeloi

- [dsp](dsp/README.md): Edw einai to DSP pou epeksergazetai ta audio blocks. Ta .mjs exoun tin ylopoihsi, enw ta .d.mts dinoun tous typous tous sto TypeScript.
