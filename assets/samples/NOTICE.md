Moveless can ship two sample libraries next to the synthesizer. They are not in git. `npm run pack-samples` downloads the same files Strudel plays and writes `samples.bin`. The module copies that file when it is present, and always copies this notice.

Drums: [tidal-drum-machines](https://github.com/geikha/tidal-drum-machines), the map Strudel loads as `tidal-drum-machines.json`. The repository note is `tidal-drum-machines.md`.

Melody: the GM preset list from `@strudel/soundfonts` (`gm.mjs`). The audio is the preset files at `https://felixroos.github.io/webaudiofontdata/sound/`, the same ones Strudel's font loader reads. That set includes FluidR3 GM by Frank Wen (`FluidR3.md`, MIT) and GeneralUser GS by S. Christian Collins (`GeneralUser-GS.txt`), plus the other soundfonts named in the preset ids.
