# ptnmove

Generative performance sequencer for Ableton Move. Seven lanes play together. You edit the live pattern, save immutable scenes, and morph between them.

ptnmove is a Schwung overtake module. It starts in Play.

[User guide](docs/README.md)

## Develop

```bash
npm test
npm run typecheck
npm run deploy
```

`deploy` builds `ui.js`, cross-compiles `dsp.so` when the voice changed, and installs the module through Schwung Manager at `http://move.local:7700/`. Open **overtake → ptnmove** on Move. If the module has already run since boot, restart Move before a new `dsp.so` is heard. Reopening the module is enough for a UI-only change.

Design notes live in [`architecture/`](architecture/README.md). `architecture/initial.md` is a historical brainstorm and is not rewritten.
