Moveless plays two sample libraries next to the synthesizer. They are not in git. `npm run pack-samples` downloads the same files Strudel plays and writes `samples.bin`, plus `bank.json` with the file size and the release URL. A module build ships `bank.json` and this notice, not the audio. On startup the module downloads `samples.bin` when the copy beside it is missing or a different size.

Drums: [tidal-drum-machines](https://github.com/geikha/tidal-drum-machines), the map Strudel loads as `tidal-drum-machines.json`. The repository note is `tidal-drum-machines.md`.

Melody: the GM preset list from `@strudel/soundfonts` (`gm.mjs`). The audio is the preset files at `https://felixroos.github.io/webaudiofontdata/sound/`, the same ones Strudel's font loader reads. That set includes FluidR3 GM by Frank Wen (`FluidR3.md`, MIT) and GeneralUser GS by S. Christian Collins (`GeneralUser-GS.txt`), plus the other soundfonts named in the preset ids.
