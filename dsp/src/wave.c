#include "engine.h"

static float wave_table[WT_MIPS * WT_FRAMES * WT_CYCLE];
static int wave_ready = 0;
static const float WT_ANCHOR[6] = {0.0f, 0.22f, 0.42f, 0.62f, 0.82f, 1.0f};

float gauss_k(float k, float center, float sigma) {
    float d = (k - center) / sigma;
    return expf(-d * d);
}

float anchor_amp(int kind, int k) {
    float kf = (float)k;
    if (kind == 0) return 1.0f / (kf * kf);
    if (kind == 1) {
        if ((k & 1) == 0) return 0.0f;
        return ((k % 4) == 1 ? 1.0f : -1.0f) / (kf * kf);
    }
    if (kind == 2) return 1.0f / kf;
    if (kind == 3) return (k & 1) ? 1.0f / kf : 0.0f;
    if (kind == 4) return sinf(3.14159265f * kf * 0.12f) / kf;
    return 0.22f / powf(kf, 1.5f) + gauss_k(kf, 3.0f, 0.9f) + 0.75f * gauss_k(kf, 8.0f, 1.2f) + 0.55f * gauss_k(kf, 14.0f, 1.5f);
}

float amp_at(float p, int k) {
    int i;
    float span, t;
    if (p <= 0.0f) return anchor_amp(0, k);
    if (p >= 1.0f) return anchor_amp(5, k);
    i = 0;
    while (i < 4 && p > WT_ANCHOR[i + 1]) i++;
    span = WT_ANCHOR[i + 1] - WT_ANCHOR[i];
    t = span > 0.0f ? (p - WT_ANCHOR[i]) / span : 0.0f;
    return anchor_amp(i, k) * (1.0f - t) + anchor_amp(i + 1, k) * t;
}

/* Cosine taper on the top third of a mip. The first partial stays; the last one is zero. */

float harm_window(int k, int max_h) {
    float knee, span, t;
    if (max_h <= 1) return 1.0f;
    knee = (float)max_h * (2.0f / 3.0f);
    if ((float)k <= knee) return 1.0f;
    span = (float)max_h - knee;
    t = ((float)k - knee) / span;
    return 0.5f * (1.0f + cosf(3.14159265f * t));
}

void ensure_wave_table(void) {
    int mip, frame, k, n;
    if (wave_ready) return;
    for (mip = 0; mip < WT_MIPS; mip++) {
        int max_h = WT_HARM >> mip;
        for (frame = 0; frame < WT_FRAMES; frame++) {
            float p = (float)frame / (float)(WT_FRAMES - 1);
            float amp[WT_HARM + 1];
            double energy = 0.0;
            int base = (mip * WT_FRAMES + frame) * WT_CYCLE;
            for (k = 1; k <= max_h; k++) amp[k] = amp_at(p, k) * harm_window(k, max_h);
            for (n = 0; n < WT_CYCLE; n++) {
                float theta = (TWO_PI * (float)n) / (float)WT_CYCLE;
                float sum = 0.0f;
                for (k = 1; k <= max_h; k++) sum += amp[k] * sinf((float)k * theta);
                wave_table[base + n] = sum;
                energy += (double)sum * (double)sum;
            }
            {
                double rms = sqrt(energy / (double)WT_CYCLE);
                if (rms > 1e-8) {
                    float norm = WT_RMS / (float)rms;
                    for (n = 0; n < WT_CYCLE; n++) wave_table[base + n] *= norm;
                }
            }
        }
    }
    wave_ready = 1;
}

float read_cycle(int mip, int frame, float u) {
    float pos = u * (float)WT_CYCLE;
    int i0 = (int)pos;
    float frac = pos - (float)i0;
    int i1;
    int base;
    float a, b;
    if (i0 >= WT_CYCLE) {
        i0 = 0;
        frac = 0.0f;
    } else if (i0 < 0) {
        i0 = 0;
        frac = 0.0f;
    }
    i1 = i0 + 1;
    if (i1 >= WT_CYCLE) i1 = 0;
    base = (mip * WT_FRAMES + frame) * WT_CYCLE;
    a = wave_table[base + i0];
    b = wave_table[base + i1];
    return a + (b - a) * frac;
}

/* Mip, frame and the low-note body weight. Callers keep the result while freq and wave stay put. */

void wave_fix(WaveFix *fix, float freq, float wave) {
    float fit, mip_f, pos, hz, body;
    int top;
    if (fix->ready && fix->freq == freq && fix->wave == wave) return;
    fit = (SR * 0.45f) / (freq > 1.0f ? freq : 1.0f);
    if (fit < 1.0f) fit = 1.0f;
    if (fit > (float)WT_HARM) fit = (float)WT_HARM;
    mip_f = logf((float)WT_HARM / fit) / logf(2.0f);
    fix->m0 = (int)floorf(mip_f);
    if (fix->m0 < 0) fix->m0 = 0;
    if (fix->m0 > WT_MIPS - 1) fix->m0 = WT_MIPS - 1;
    top = fix->m0 >= WT_MIPS - 1;
    fix->m1 = top ? fix->m0 : fix->m0 + 1;
    fix->mf = (top || mip_f - (float)fix->m0 < 1e-4f) ? 0.0f : mip_f - (float)fix->m0;
    pos = wave < 0.0f ? 0.0f : (wave > 1.0f ? 1.0f : wave);
    pos *= (float)(WT_FRAMES - 1);
    fix->f0 = (int)floorf(pos);
    if (fix->f0 >= WT_FRAMES - 1) fix->f0 = WT_FRAMES - 2;
    fix->ff = pos - (float)fix->f0;
    if (freq >= 200.0f) fix->body = 0.0f;
    else {
        hz = freq > 1.0f ? freq : 1.0f;
        body = (log2f(200.0f) - log2f(hz)) / 2.0f;
        if (body <= 1e-4f) body = 0.0f;
        else if (body > 1.0f) body = 1.0f;
        fix->body = 0.5f * body;
    }
    fix->freq = freq;
    fix->wave = wave;
    fix->ready = 1;
}

float wave_read(const WaveFix *fix, float u) {
    float s0 = read_cycle(fix->m0, fix->f0, u) * (1.0f - fix->ff) + read_cycle(fix->m0, fix->f0 + 1, u) * fix->ff;
    float s1;
    if (fix->mf > 0.0f) {
        s1 = read_cycle(fix->m1, fix->f0, u) * (1.0f - fix->ff) + read_cycle(fix->m1, fix->f0 + 1, u) * fix->ff;
        s0 = s0 + (s1 - s0) * fix->mf;
    }
    if (fix->body <= 0.0f) return s0;
    return s0 * (1.0f - fix->body) + sinf(TWO_PI * u) * fix->body;
}

float read_wave(float freq, float wave, float u) {
    WaveFix fix;
    fix.ready = 0;
    wave_fix(&fix, freq, wave);
    return wave_read(&fix, u);
}
