# Project

There is one project. It saves itself, and it comes back by itself. There is no save button, and there doesn't need to be.

## Where it lives

`/data/UserData/schwung/moveless/project.json` on the Move itself. This is outside the module folder, so updating moveless doesn't touch it.

The module carries a factory journal next to itself: `factory.json` in the module directory. If you don't have a project of your own yet, the first launch copies this file into the user directory. Installing again updates the factory inside the module, and doesn't overwrite a project that was already copied.

`npm run pull-project` pulls the live project off the Move through Schwung Manager and writes it to `assets/factory.json`. It looks at the new path first, and if the file isn't there, the old `/data/UserData/schwung/ptnmove/project.json`.

## When it saves

A couple of seconds after any change, and when the module closes. If you turn the Move off right in the middle of turning a knob, the most you'll lose is that knob.

## What is inside

- **The journal** — every scene, with its colours.
- **The sets** — links to scenes, up to 32 in each.
- **The live pattern** — what is sounding right now, even if it hasn't been recorded.
- **The progression, global, the mix bus** — the purple button's pages.
- **The mixer** — levels, mute, solo, lock.
- **The deck knobs** — the tone strip included.
- **The bookmarks**.
- **The transition and wander** — the chosen speeds.
- **The copy buffer** — the scenes marked for pasting.
- **Where you were** — the lane, the page, journal or set, whether the mixer or the deck is open, whether the randomizer is latched, the transition row, the deck knob layer, whether the transport is running.

## What is not inside

- The morph itself. If you turn it off in the middle of a transition, on startup you get whatever it had reached.
- The deck gesture. A held pad doesn't sound when you turn it on.
- An outside chord from MIDI. Until the first note, there is no harmony.

## Factory

A new project starts in play, with a set of ready-made scenes in the journal — there is something to listen to, and something to push off from. The set is empty, so at first wander walks the whole journal. The factory lane values are dull, though: a minimal sound, no hits. Delete + a lane button takes you back to them, or shift + delete for all of them at once. The default progression is four chords, one per bar, the transition is fast, wander is off. How to start from a blank page is in the [first session](first-session.md).

[Guide](README.md)
