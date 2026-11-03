/* Host build. Prints pure-function vectors for scripts/test-dsp.ts. */
#include "engine.h"

#include <stdio.h>

static void decay(const char *name, float (*fn)(float)) {
    static const float units[] = { 0.0f, 0.2f, 0.5f, 0.8f, 1.0f };
    for (int i = 0; i < 5; i++) printf("decay %s %.6f %.9g\n", name, units[i], fn(units[i]));
}

int main(void) {
    static const float units[] = { 0.0f, 0.06f, 0.1f, 0.21f, 0.3f, 0.5f, 0.9f, 1.0f };
    static const int motifs[] = { 0, 1, 7, 8, 15, 63 };
    static const float phases[] = { 0.0f, 0.25f, 0.5f, 0.9f };
    static const int steps[] = { 16, 16, 8, 5 };
    static const int pulses[] = { 4, 4, 3, 2 };
    static const float ephase[] = { 0.0f, 0.25f, 0.5f, 0.1f };
    int lens[16], types[16], signs[16], count = 0, sum = 0, i, n;
    decay("kick", kick_decay_seconds);
    decay("bend", bend_time_seconds);
    decay("snare_body", snare_body_decay_seconds);
    decay("snare_noise", snare_noise_decay_seconds);
    decay("hat", hat_decay_seconds);
    decay("perc", perc_decay_seconds);
    for (n = 0; n < 4; n++) {
        for (i = 0; i < 5; i++) {
            float u = (float)i / 4.0f;
            printf("pitch %d %.6f %.9g\n", n, u, drum_pitch_hz(n, u));
        }
    }
    for (i = 0; i < 8; i++) printf("fm %.6f %.9g\n", units[i], fm_ratio_of(units[i]));
    for (n = 0; n < 6; n++) {
        for (i = 0; i < 4; i++) printf("motif %d %.6f %.9g\n", motifs[n], phases[i], motif_at(motifs[n], phases[i]));
    }
    for (i = 0; i < 4; i++) printf("euclid %d %d %.6f %.9g\n", steps[i], pulses[i], ephase[i], euclid_gate(steps[i], pulses[i], ephase[i]));
    for (i = 0; i < 5; i++) {
        float u = (float)i / 4.0f;
        printf("iso %.6f %.9g\n", u, deck_iso_gain(u));
    }
    deck_scratch_roll(2, 1, 3, 1, lens, types, signs, &count, &sum);
    printf("scratch %d %d", count, sum);
    for (i = 0; i < count; i++) printf(" %d:%d:%d", lens[i], types[i], signs[i]);
    printf("\n");
    return 0;
}
