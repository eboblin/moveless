# ptnmove

Generative performance sequencer for Ableton Move. Seven lanes play together. You edit the live pattern, save immutable scenes, and morph between them.

ptnmove is a Schwung overtake module. It starts in Play.

## Screen

The display is three bands:

- **Header** — current lane and page. Touch a knob and this line shows that parameter’s full name.
- **Pager** — the one-pixel line under the header. The current page is a solid segment. The others are dotted.
- **Phrase** — time runs left to right. Height is pitch, including drums. A note’s height is its velocity, and never more than half the band. The playhead inverts the pixels it crosses.
- **Parameters** — the knobs on this page. Touch a knob and its label plus value invert.

Touch a generator knob (`value`, `pattern`, `cycle`, or `amount`) and the phrase is replaced by that generator, drawn on the phrase’s time scale. Release it and the phrase returns after 300 ms. `pattern` with amount 0 draws the shape itself.

A generator’s **cycle is a length in sixteenths**, not in notes. Cycle 1 is every sixteenth. Cycle 4 is a quarter note. When a note starts, it reads the generator’s current value. Drum pitch stays at that value for the whole hit. Filters and the other sound parameters keep following the generator while the note is held.

Changing Transition or Wander covers the phrase for half a second with the choice, then the phrase returns.

## Lanes

The step buttons select a lane. A short press switches to it. The selected step blinks once per quarter note, in time with the tempo.

| Step | Lane |
| --- | --- |
| 1–4 | Kick, Snare, Hat, Perc |
| 5–6 | Bass, Lead |
| 7 | Chords |
| 8 | Mixer |
| 9 | Global |

Hold a lane button to peek at it. The top pad rows become page buttons and stay that way until you release the lane button. Pressing a page pad changes the page and does not end the hold. A long hold with no page pad returns to the lane you were on.

The jog wheel moves one page at a time. Touching the wheel does not change the screen. While your finger is on it, the pads are a shortcut layer:

- Top row — pages 1–8
- Next row down — pages 9–10 when the lane has them
- Bottom row — Transition (left four) and Wander (right four)

Page pads are colored by group. The current page blinks.

**Drums** — two groups. Orange: Event A, Event B, Form, Count/Rate. Violet: four sound pages.

**Bass and Lead** — three groups. Orange: generators, repeat. Teal: Pitch/Octave, Length/Follow. Violet: four sound pages.

**Chords** — two groups. Teal: Change/Length, Motion/Variation, Mood/Tension, Play. Violet: four sound pages.

**Mixer** is one page: seven lane levels and master.

**Global** is tempo, swing, root, scale, transpose, bar, phrase length, and seed, then macro pages. A macro offsets a parameter that exists on at least two lanes. Record does not bake macros into a scene. A locked lane ignores them.

## Scenes

**Record** appends a new scene to the Journal. It never overwrites. Each scene gets its own pad color. The newest occupied pad blinks. Empty pads stay off. The Journal shows the last 32 scenes, oldest at the bottom left.

The **Menu** button (three lines under the jog) switches the pads between Journal and Set. The button is yellow in Journal and purple in Set.

A scene pad morphs the live pattern into that scene. Fast, Medium, and Slow start on the next bar. Now starts on the next sixteenth. If the transport is already on that grid, the morph starts immediately.

| Transition | Length |
| --- | --- |
| Now | 0 bars |
| Fast | 1 bar |
| Medium | 4 bars |
| Slow | 8 bars |

A locked lane is left as it is. A knob turned during the morph keeps the value you set.

**Wander** picks the next scene by itself and uses the current Transition. The intervals are 2, 8, 16, and 32 bars. Press the active rate again to turn Wander off. It reads the active Set, or the Journal when that Set is empty.

**Copy** puts the newest Journal scene on the clipboard. Hold Copy and press a pad in Set mode to add that scene to the active Set. The Journal scene stays. **Delete** plus a lane step restores that lane’s parameters to the factory defaults. Mute, lock, and the mixer stay. **Delete** plus a scene pad always deletes that pattern: in Set it drops the reference from the active Set; in Journal it removes the scene and every Set link to it. **Delete** plus **Down** deletes the Set itself. **Up** and **Down** move between Sets.

## Other controls

- **Mute** plus a lane button toggles mute. Muted drums and notes go silent. Muted chords still feed Bass and Lead.
- **Loop** plus a lane button locks that lane. Morph, Wander, Capture, and macros leave it alone.
- **Capture** rerolls on release. On a pattern page it rerolls that lane’s pattern. On a notes page it rerolls the note generators. On a sound page it rerolls the sound. **Shift + Capture** rerolls the whole selected lane (pattern, notes, and sound). Hold Capture and touch or turn any knob of one generator — including LENGTH / HITS / ROTATE / PROBABILITY on GEN pages — to reroll that generator immediately. The last generator you touch wins.
- **Track** buttons 1–4 are bookmarks. A short press jumps to the stored lane and page. Hold one to store the page you are on. A stored button lights in that page group's colour and changes colour when you overwrite it. An empty button stays off. The bookmark you are currently on blinks.

Leave the module with **Shift + volume touch + jog click**.

## Develop

```bash
npm test
npm run typecheck
npm run deploy
```

`deploy` builds `ui.js`, cross-compiles `dsp.so` when the voice changed, and installs the module through Schwung Manager at `http://move.local:7700/`. Open **overtake → ptnmove** on Move. If the module has already run since boot, restart Move before a new `dsp.so` is heard. Reopening the module is enough for a UI-only change.

The single project (journal, sets, working, prefs) is stored at `/data/UserData/schwung/ptnmove/project.json` and restored on open.

Design notes live in `architecture/`. `architecture/initial.md` is a historical brainstorm and is not rewritten.
