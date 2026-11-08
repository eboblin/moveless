# Bass and lead

Two yellow buttons, the same instrument at a different pitch. The bass is in the third octave by default, the lead in the fourth. Thirteen pages in four groups, and the second line of pages runs onto the second row of pads.

![A finger on the jog with bass selected. Top row: three orange pattern pads, a white blinking one — the current pitch / octave page, a turquoise length pad, three blue sound pads. Second row: two more blue ones and two green ones — the filter and the sends. The screen says PITCH / OCTAVE](../images/shot-11.png)

## Orange: pattern

**Generator 1** and **generator 2** are two euclidean generators, the same length, hits, rotate, probability, and vel. Generator 1 places single notes. Generator 2 places notes that can unfold into a run. If they land together, there is one note, and that note is a run.

**Repeat / span** is the run. Repeat (count) is how many equal parts the note length is divided into: 1 is one note, and it goes up to eight. Span is where the run travels: the middle is nowhere, the edges are seven scale degrees up or down over the whole pass. The first part stays on pitch, the last one leaves for span.

This is not a drum roll: a run divides the note, not the grid, and it walks the scale degrees.

## Turquoise: notes

**Pitch / octave**. Pitch 50 is the root of the chosen scale, the edges are two octaves of the scale to either side. While the knob is held, the header writes the note name. Octave is the absolute octave, 0..9, and it simply shifts that window. The degree and the octave add together.

![The bass / PITCH screen with PITCH V held: the header shows the note C3 instead of the page name, and the V column with the number 50 is inverted. A saw of the pitch envelope is drawn over the loop, cycle 16, and the notes follow it in steps. At the bottom: pitch 50 / 1 / 16 / 10, octave 3 / 0 / 1 / 0](../images/shot-12.png)

**Length / follow**. Length is the note length. Follow is how much the note listens to the [harmony](harmony.md): 0 means it stays in the scale, 100 means it sits on the nearest tone of the chord that is sounding. A bass with follow 100 always goes with the progression. A lead with follow 50 sometimes agrees, sometimes doesn't.

All five are a full VPCA. A melody in moveless is pitch with a shape. Pattern sets the contour, cycle sets how long it takes to repeat, amount sets how wide it is.

## Blue: sound

Five pages, two knobs each, the same for the bass, the lead, and the chords. The voice is a unison wavetable.

- **Wave / glide**. Wave travels from a dark tone, through triangle, saw, and square, to a vowel. Glide is portamento: zero is a jump, higher, and the pitch catches up to the target.
- **Sync / fold**. Hard sync and fold. Both do nothing at zero.
- **Drive / wide**. Drive is a soft clip. Wide is two side copies, detuned outward: a chorus that doesn't lose volume.
- **Attack / sustain**. Attack is the share of the note length up to the peak. Sustain is the volume at the end of the note: 0 is a pluck, 1 is a shelf.
- **Release / flt env**. Release is the tail after the note ends. Env is how far the filter opens on the attack and closes toward the end of the note.

**Sample** follows those five. Two knobs, category and instrument. Zero on the category is the wavetable. Above zero, the bass, the lead, and the chords share one GM list, split into families (piano, bass, pad). Instrument walks the programs inside the locked family, and the takes between detents are soundfonts. The note picks the zone that covers its pitch. Attack, sustain, release, env, drive, glide, and wide stay on the recording.

The volume envelope is tied to the note length: a long note is a long attack, a short note is a short one. A short length and a high release is a stab.

## Green: filter and sends

The same as everywhere: flt cutoff / flt reso, then rev / dly. Cutoff at 50 is transparent, left is high-pass, right is low-pass.

## The screen

A note in the loop is a strip: pitch goes up, the width is length. If a note runs past the end of the loop, the tail is carried to the start. Bass and lead are monophonic: one note in one sixteenth.

![The bass / LENGTH screen with LENGTH V held: LENGTH VALUE and BAS in the header. A triangular length envelope is drawn over the loop, and the notes under it are dimmed with a grid and have different widths — where the envelope is higher, the strip is longer. At the bottom: length 54 / 5 / 22 / 42 and FOL 100](../images/shot-13.png)

## Tips

- An empty bass: gen 1 at 16/5, pitch amount around 30 with a short cycle, and follow 100. That is already music.
- A lead on a different ring (12 or 10), relative to the bass, gives phrases that don't end together with the bar.
- Repeat 3–4 with span down, on a few notes of gen 2, is a ready-made fill.
- Cutoff with pattern -1 and a small amount: the filter opens a little on every kick.

[Guide](README.md)
