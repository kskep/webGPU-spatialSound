# ui

Edw einai ta controls kai i provoli tis efarmogis. Ta akoustika dedomena erxontai apo ta ypoloipa folders kai edw ta emfanizw i ta syndew me tis energeies tou xristi.

## Arxeia

- [controls.ts](controls.ts): Ftiaxnw ta DOM elements kai ta arxika values pou diavazoun oi controllers. Ta perissotera einai kryfa kai ta xeirizetai to dat.GUI panel.
- [debug-readouts.ts](debug-readouts.ts): Metatrepw trace, decay, scheduler kai probe data se keimena gia to debug panel. Enimerwnw kai tis times twn controls apo ti skini.
- [orientation-indicator.ts](orientation-indicator.ts): Sxediazw to velos pou deixnei ton prosanatolismo tis pigis. Xrisimopoiw to source forward vector kai to style apo to config.
- [original-ui.ts](original-ui.ts): Ftiaxnw to dat.GUI panel kai syndew ta controls me ta DOM elements. Topothetw viewport, response plot kai debug panel sti selida.
- [playback-controller.ts](playback-controller.ts): Syndew Play Original, Play Convolved, Stop, sound selection kai volume me to AudioPreview. Neo trace enimerwnei to audio mono otan paizei convolved.
- [plots.ts](plots.ts): Sxediazw energy histogram, smoothed envelope kai Schroeder decay sto canvas. Etsi fainetai pos ftanei kai pos svinei i energeia me ton xrono.
- [probe-panel.ts](probe-panel.ts): Ftiaxnw ta controls gia probe mode, grid, selected probe kai baking. Ta koumpia import/export doulevoun me ton ProbeController.
- [room3d.ts](room3d.ts): Syndew camera, room, source, objects, rays kai probes se ena WebGPU viewport. Xeirizomai keyboard/mouse input kai enimerwnw ti thesi tou listener.
