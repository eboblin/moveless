# Transition

Pressing a scene pad doesn't switch the pattern, it morphs: the live knobs travel from what is there to what is recorded in the scene. The transition is how long they travel. Wander is the autopilot, which presses the pads by itself.

## The transition row

Press <img src="../icons/sample.png" width="20" alt="sample"> **sample**. Instead of the bottom row of scenes, the bottom row is taken by eight pads: four yellow (the transition) and four purple (wander). The selected one glows at ordinary brightness, the rest are dim.

A short press of sample leaves the row in place, a long hold keeps it while the finger is down. The button is lit while the row is visible.

![The bottom row of pads after sample: four yellow ones — the transition, the first one selected, now; four purple ones — wander, the first one selected, off. The rest are dim](../images/shot-21.png)

The yellow ones, left to right:

<table>
<tr><td align="center"><img src="../icons/pad-tr-now.png" width="48" alt="now"></td><td align="center"><img src="../icons/pad-tr-fast.png" width="48" alt="fast"></td><td align="center"><img src="../icons/pad-tr-med.png" width="48" alt="medium"></td><td align="center"><img src="../icons/pad-tr-slow.png" width="48" alt="slow"></td></tr>
<tr><td align="center">0 bars</td><td align="center">1 bar</td><td align="center">4 bars</td><td align="center">8 bars</td></tr>
</table>

Now doesn't wait for the bar: every knob jumps on the nearest sixteenth.

Fast, medium, and slow start on the next bar. Now starts on the next sixteenth. If the transport is right on the boundary, it starts at once.

On the screen, when it changes, TRANSITION appears big over SLOW, for half a second.


Two things the morph doesn't touch:

- **A locked lane** stays as it was.
- **A knob you turned during the morph** stays yours. The morph takes it off the route.

The progression, the global settings, the macros, the mixer, and the bus don't morph — they aren't in the scene.

## Wander

Wander picks the next scene itself and starts a transition toward it. The purple pads:

<table>
<tr><td align="center"><img src="../icons/pad-wa-off.png" width="48" alt="off"></td><td align="center"><img src="../icons/pad-wa-fast.png" width="48" alt="fast"></td><td align="center"><img src="../icons/pad-wa-med.png" width="48" alt="medium"></td><td align="center"><img src="../icons/pad-wa-slow.png" width="48" alt="slow"></td></tr>
<tr><td align="center">off</td><td align="center">2 bars of pause</td><td align="center">8 bars</td><td align="center">16 bars</td></tr>
</table>

![Four purple wander pads, medium lit](../images/shot-22.png)

The pause is counted after the previous transition lands, until the next one starts. The transition itself runs at the current speed from the yellow row. So slow + slow means eight bars of travelling, sixteen of standing still.

Where it takes scenes from: the current [set](scenes.md). If the set is empty, from the journal. It doesn't repeat the previous target.

And the main thing: wander doesn't drag everything along. On each step, each unlocked lane drops into the transition with a one-in-two chance, a silent one less often. If none of them dropped in, one lane that is sounding is taken. The lanes that dropped in split the whole transition window between them, in the same role order, instead of all entering at once. So the result is not your scenes one after another, but a mix of them that you never recorded.

## Tips

- Slow on the transition and slow on wander, with the kick and the bass locked — a background for half an hour that doesn't get old.
- Now is for playing scenes live, like clips. Record scenes that are variations of one groove, and hit the pads.
- During a long morph, turn something by hand: that is yours, and it stays.

[Guide](README.md)
