# acoustics

Edw exw tous ypologismous tis akoustikis. Ta arxeia pairnoun ti skini kai tis afikseis tou ixou, xwris na ftiaxnoun to UI i na kanoun playback.

## Arxeia

- [air.ts](air.ts): Ypologizw tin aporrofisi tou aera se dB ana metro gia 8 bandes syxnotiton. Xrisimopoiw thermokrasia, ygrasia kai piesi me ti sxesi ISO 9613-1.
- [decay-fit.ts](decay-fit.ts): Vgazw RT60 ana banda apo tin ptwsi tis energeias twn stochastic hits. An to fit den einai aksiopisto, kratame tin ektimisi Eyring.
- [direction-bins.ts](direction-bins.ts): Moirazw to omalopoiimeno energy envelope se katefthynseis gyrw apo ton listener. Krataw tin idia synoliki energeia ana banda.
- [directivity.ts](directivity.ts): Ypologizw pos allazei i energeia pou ekpempei i pigi analoga me ti gwnia. Kanw normalisation gia na paramenei idia i synoliki isxys.
- [envelope.ts](envelope.ts): Omalopoiw ta araia ray hits me Hann kernel kai platos pou eksartatai apo ta geitonika hits. Diorthwnw gia tin aposvesi kai diatirw tin energeia.
- [model.ts](model.ts): Edw orizw Scene, Arrival, TraceResult kai tis vasikes times. Exw episis elegxous skinis, image-source early reflections, Eyring kai energy histograms.
- [occlusion.ts](occlusion.ts): Elegxw an antikeimena kovoun tis early diadromes. Aporriptw tis mplokarismenes anaklaseis kai gia ton ameso ixo dokimazw proseggisi diffraction apo akmes.
- [room-decay-cache.ts](room-decay-cache.ts): Krataw to teleutaio room decay apo full-quality trace. Etsi ena pio proxeiro trace den allazei synexeia to RT60. Allagi skinis katharizei tin cache.
- [room-parameters.ts](room-parameters.ts): Analyw ena impulse response gia T20, T30, EDT, clarity, definition kai DRR. Exw kai Lundeby noise handling kai binaural deiktes IACC/ILD.
- [room-preset.ts](room-preset.ts): Metatrepw ena room preset se Scene me diastaseis, ylika kai theseis. Krataw kai ti metatropi twn legacy presets gia sygkriseis.
- [specular-echoes.ts](specular-echoes.ts): Omadopoiw ray hits pou akolouthisan tis idies epifaneies kai ta kanw xexwrista echoes. Exw exact image-source anakataskevi kai prosorini mnimi diadromwn.
