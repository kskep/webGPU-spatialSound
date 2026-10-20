# audio/dsp

Edw einai to DSP pou epeksergazetai ta audio blocks. Ta .mjs exoun tin ylopoihsi, enw ta .d.mts dinoun tous typous tous sto TypeScript.

## Arxeia

- [block-cost.mjs](block-cost.mjs): Metraw poso xrono pairnei ena audio block kai ton sygkrinw me ton diathesimo xrono tou quantum. Krataw mean, max kai overruns.
- [hybrid-core.mjs](hybrid-core.mjs): Syndew streaming convolution, late FDN kai ta optional room modes. Allazw responses me crossfade kai diatirw to istoriko tou ixou.
- [late-fdn.d.mts](late-fdn.d.mts): Edw dilwnw tous typous gia tis rythmiseis, ta outputs kai tis synartiseis tou late FDN. Den trexei audio apo mono tou.
- [late-fdn.mjs](late-fdn.mjs): Ylopoihw to persistent late reverb me feedback delay networks ana banda. Diaxeirizomai decay gains, delay layouts kai interaural coherence.
- [room-modes.d.mts](room-modes.d.mts): Orizw tous TypeScript typous gia room modes, resonators kai modal configurations. Antistoixoun stin ylopoihsi room-modes.mjs.
- [room-modes.mjs](room-modes.mjs): Ypologizw modes gia shoebox geometry kai ta apodidw me resonators stis xamiles syxnotites. Einai optional layer kai sto app einai kleisto apo default.
- [room-processor.mjs](room-processor.mjs): Einai to entry point tou AudioWorklet. Pairnw minimata me nees responses, epeksergazomai audio blocks kai epistrefw telemetry i errors.
- [stream-core.d.mts](stream-core.d.mts): Dilwnw tous typous gia prepared convolution responses kai tis export synartiseis FFT kai prepareResponse tou stream-core.mjs.
- [stream-core.mjs](stream-core.mjs): Exw FFT kai partitioned stereo convolution. Krataw istoriko input kai kanw crossfade otan allazei to FIR, xwris na xanetai o prohgoumenos ixos.
