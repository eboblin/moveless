#include "engine.h"

int suffix_is(const char *id, const char *suffix) {
    int n = (int)strlen(id);
    int s = (int)strlen(suffix);
    if (n < s) return 0;
    if (strcmp(id + n - s, suffix) != 0) return 0;
    return n == s || id[n - s - 1] == '_';
}

float euclid_gate(int steps, int pulses, float phase) {
    int idx = (int)floorf(phase * (float)steps) % steps;
    if (idx < 0) idx += steps;
    int hits = pulses < 1 ? 1 : pulses;
    if (hits > steps) hits = steps;
    for (int p = 0; p < hits; p++) {
        if ((p * steps) / hits == idx) return 1.0f;
    }
    return -1.0f;
}

float motif_at(int id, float phase01) {
    int index = id % 64;
    if (index < 0) index += 64;
    float phase = wrap01(phase01);
    int kind = index % 8;
    int variant = 1 + index / 8;
    float sample = 0;
    switch (kind) {
    case 0: sample = sinf(TWO_PI * (float)variant * phase); break;
    case 1: sample = 2.0f * wrap01((float)variant * phase) - 1.0f; break;
    case 2: sample = wrap01((float)variant * phase) < 0.5f ? 1.0f : -1.0f; break;
    case 3: {
        float x = wrap01((float)variant * phase);
        sample = x < 0.5f ? 4.0f * x - 1.0f : 3.0f - 4.0f * x;
        break;
    }
    case 4: {
        float steps = (float)(variant + 1);
        float q = floorf(phase * steps) / steps;
        sample = sinf(TWO_PI * (float)(1 + (variant % 3)) * q);
        break;
    }
    case 5: {
        float x = wrap01((float)variant * phase);
        sample = 1.0f - 4.0f * fabsf(x - 0.5f);
        break;
    }
    case 6: sample = euclid_gate(4 + variant, 1 + (variant % 5), phase); break;
    default: {
        int bucket = (int)floorf(phase * (float)(4 + variant));
        sample = bucket % (1 + (variant % 3)) == 0 ? 1.0f : -0.35f;
        break;
    }
    }
    if (sample > 1) return 1;
    if (sample < -1) return -1;
    return sample;
}

int param_of(const char *id) {
    if (strcmp(id, "wave") == 0) return P_WAVE;
    if (strcmp(id, "bend") == 0) return P_BEND;
    if (strcmp(id, "sync") == 0) return P_SYNC;
    if (strcmp(id, "fold") == 0) return P_FOLD;
    if (strcmp(id, "drive") == 0) return P_NOTE_DRIVE;
    if (strcmp(id, "cutoff") == 0) return P_CUTOFF;
    if (strcmp(id, "resonance") == 0) return P_RESONANCE;
    if (strcmp(id, "reverb") == 0) return P_REVERB;
    if (strcmp(id, "delay") == 0) return P_DELAY;
    if (strcmp(id, "attack") == 0) return P_ATTACK;
    if (strcmp(id, "release") == 0 || strcmp(id, "decay") == 0) return P_RELEASE;
    if (strcmp(id, "wide") == 0) return P_WIDE;
    if (strcmp(id, "glide") == 0) return P_GLIDE;
    if (strcmp(id, "sustain") == 0) return P_SUSTAIN;
    if (strcmp(id, "env") == 0) return P_ENV;
    if (suffix_is(id, "freq")) return P_FREQ;
    if (suffix_is(id, "btime")) return P_BTIME;
    if (suffix_is(id, "pbend")) return P_PBEND;
    if (suffix_is(id, "bdcy")) return P_BDCY;
    if (suffix_is(id, "ndcy")) return P_NDCY;
    if (suffix_is(id, "decay")) return P_DECAY;
    if (suffix_is(id, "click")) return P_CLICK;
    if (suffix_is(id, "noise")) return P_NOISE;
    if (suffix_is(id, "dist")) return P_DIST;
    if (suffix_is(id, "body")) return P_BODY;
    if (suffix_is(id, "snap")) return P_SNAP;
    if (suffix_is(id, "tone")) return P_TONE;
    if (suffix_is(id, "metal")) return P_METAL;
    if (suffix_is(id, "color")) return P_COLOR;
    if (suffix_is(id, "atk")) return P_ATK;
    if (suffix_is(id, "ring")) return P_RING;
    if (suffix_is(id, "pos")) return P_POS;
    if (suffix_is(id, "ratio")) return P_RATIO;
    if (suffix_is(id, "damp")) return P_DAMP;
    if (suffix_is(id, "mat")) return P_MAT;
    if (suffix_is(id, "fm")) return P_FM;
    return P_NONE;
}

float eval_one(float value, int pattern, float cycle, float amount, float step) {
    if (pattern < 0 || amount == 0.0f) return clampf01(value);
    int length = (int)roundf(cycle);
    if (length < 1) length = 1;
    float wrapped = fmodf(step, (float)length);
    if (wrapped < 0) wrapped += (float)length;
    return clampf01(value + motif_at(pattern, wrapped / (float)length) * amount);
}
