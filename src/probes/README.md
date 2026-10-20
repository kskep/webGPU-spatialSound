# probes

Edw apothikevw to stochastic pedio se theseis mesa sto dwmatio. Apo ta baked probes mporw na parw blended data gia ton listener xwris neo live trace.

## Arxeia

- [probe-baker.ts](probe-baker.ts): Trexw baking gia ta probes me seira, sympiezontas ta hits kai kratwntas decay fit. Xeirizomai progress, akyrwsi kai allages skinis kata ti diarkeia.
- [probe-blend.ts](probe-blend.ts): Epilegw ta kontina usable probes me elegxo optikis epafis. Ypologizw smooth inverse-distance weights kai syndyazw ta fields kai ta RT60 tous.
- [probe-data.ts](probe-data.ts): Metatrepw stochastic hits se time/direction/band grids gia apothikefsi. Exw blending twn grids kai metatropi tous pali se arrivals gia to audio.
- [probe-keys.ts](probe-keys.ts): Ftiaxnw keys gia ti skini kai tin pigi. Ta xrisimopoiw gia na elegxw an ena bake isxyei akoma i an exei ginei stale.
- [probe-set.ts](probe-set.ts): Diaxeirizomai add, move, delete, grid generation kai validation twn probes. Krataw bake states kai kanw import/export tou probe set se JSON.
- [probe-view.ts](probe-view.ts): Etoimazw ta spheres, ta xromata kai tis blend lines pou tha sxediasei to viewport. Exw kai ray picking gia na epilegetai ena probe me klik.
