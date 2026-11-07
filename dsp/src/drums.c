#include "engine.h"

float fade01(float u, float a, float b) {
    float x;
    if (u <= a) return 0;
    if (u >= b) return 1;
    x = (u - a) / (b - a);
    return x * x * (3.0f - 2.0f * x);
}

float lerp_stops(const float *stops, int n, float t) {
    float u = clampf01(t) * (float)(n - 1);
    int i = (int)floorf(u);
    float f;
    if (i > n - 2) i = n - 2;
    if (i < 0) i = 0;
    f = u - (float)i;
    return stops[i] * (1.0f - f) + stops[i + 1] * f;
}

float perc_noise_amt(float material) {
    static const float stops[6] = {0.14f, 0.2f, 0.1f, 0.03f, 0.07f, 0.04f};
    return lerp_stops(stops, 6, material);
}

float perc_tone(float material) {
    static const float stops[6] = {0.22f, 0.35f, 0.4f, 0.62f, 0.75f, 0.7f};
    return lerp_stops(stops, 6, material);
}

void refresh_drum_env(Drum *drum) {
    float body = drum->lane == 2 ? drum->decay * (1.0f + drum->ring * 2.8f) : drum->decay;
    float ndcy = drum->noise_decay < 0.003f ? 0.003f : drum->noise_decay;
    float bend = drum->bend_time < 0.004f ? 0.004f : drum->bend_time;
    float tau = drum->lane == 1 ? 40.0f + powf(1.0f - drum->click, 1.4f) * 700.0f : 12.0f + drum->click * 520.0f;
    if (body < 0.004f) body = 0.004f;
    if (tau < 1.0f) tau = 1.0f;
    drum->env_k = expf(-1.0f / (body * SR));
    drum->noise_k = expf(-1.0f / (ndcy * SR));
    drum->pitch_k = expf(-1.0f / (bend * SR));
    drum->click_k = expf(-1.0f / tau);
}

void apply_drum(Drum *drum, int param, float unit) {
    float u = clampf01(unit);
    switch (param) {
    case P_DECAY:
        if (drum->lane == 2) {
            drum->decay = hat_decay_seconds(u);
            drum->noise_decay = drum->decay;
        } else if (drum->lane == 3) {
            drum->decay = perc_decay_seconds(u);
            drum->noise_decay = drum->decay * 0.4f;
            if (drum->noise_decay > 0.09f) drum->noise_decay = 0.09f;
            drum->bend_time = drum->decay * 0.7f;
            if (drum->bend_time < 0.03f) drum->bend_time = 0.03f;
        } else drum->decay = kick_decay_seconds(u);
        refresh_drum_env(drum);
        break;
    case P_BDCY:
        drum->decay = snare_body_decay_seconds(u);
        refresh_drum_env(drum);
        break;
    case P_NDCY:
        drum->noise_decay = snare_noise_decay_seconds(u);
        refresh_drum_env(drum);
        break;
    case P_PBEND:
        drum->bend = u * (drum->lane == 3 ? 3.5f : 3.0f);
        break;
    case P_BTIME:
        drum->bend_time = bend_time_seconds(u);
        refresh_drum_env(drum);
        break;
    case P_BODY:
    case P_MAT:
    case P_METAL:
        drum->body = u;
        if (drum->lane == 0) drum->tone = 0.12f + u * 0.35f;
        if (drum->lane == 1) {
            drum->ratio = 1.4f + u * 0.8f;
            snare_pitch_bend(u, &drum->bend, &drum->bend_time);
            refresh_drum_env(drum);
        }
        if (drum->lane == 3) {
            drum->noise = perc_noise_amt(u);
            drum->tone = perc_tone(u);
        }
        break;
    case P_CLICK:
    case P_SNAP:
    case P_ATK:
        drum->click = u;
        refresh_drum_env(drum);
        break;
    case P_NOISE: drum->noise = u; break;
    case P_DIST: drum->drive = u; break;
    case P_TONE:
    case P_COLOR: drum->tone = u; break;
    case P_RING:
        drum->ring = u;
        refresh_drum_env(drum);
        break;
    case P_POS: drum->pos = u; break;
    case P_FM: drum->fm = u; break;
    case P_RATIO: drum->ratio = fm_ratio_of(u); break;
    case P_DAMP: drum->damp = u; break;
    case P_CUTOFF: drum->cutoff = u; break;
    case P_RESONANCE: drum->resonance = u; break;
    case P_REVERB: drum->reverb = u; break;
    case P_DELAY: drum->delay = u; break;
    default: break;
    }
}

void arm_drum(Engine *engine, int lane, int note, int velocity, const char *params, int loop) {
    int idx = lane < DRUMS ? lane : 0;
    Drum *drum = &engine->drums[idx];
    float pitch = clampf01(read_param(params, "freq", 0.5f));
    float vel = velocity / 127.0f;
    drum->gain = vel;
    (void)engine;
    (void)note;
    drum->on = 1;
    drum->lane = idx;
    if (idx == 0) engine->pump_env = 1.0f;
    if (idx == LANE_PERC) {
        drum->haas_i = 0;
        memset(drum->haas, 0, sizeof drum->haas);
    }
    drum->phase0 = 0;
    drum->phase1 = 0;
    drum->phase2 = 0;
    drum->phase3 = 0;
    drum->click_phase = 0;
    drum->env = vel;
    drum->noise_env = vel;
    drum->pitch_env = 1;
    drum->age = 0;
    drum->freq = drum_pitch_hz(idx, pitch);
    drum->loop = loop;
    drum->nlp = 0;
    drum->nhp = 0;
    drum->flt = 0;
    drum->band = 0;
    drum->fm = 0;
    drum->ratio = 1;
    drum->ring = 0;
    drum->pos = 0.5f;
    drum->damp = 0;
    drum->drive = 0;
    if (idx == 0) {
        drum->decay = kick_decay_seconds(read_param(params, "decay", 0.4f));
        drum->noise_decay = 0.045f;
        drum->bend = clampf01(read_param(params, "pbend", 0.4f)) * 3.0f;
        drum->bend_time = bend_time_seconds(read_param(params, "btime", 0.4f));
        drum->body = clampf01(read_param(params, "body", 0.1f));
        drum->click = clampf01(read_param(params, "click", 0.1f));
        drum->noise = clampf01(read_param(params, "noise", 0.1f));
        drum->tone = 0.12f + drum->body * 0.35f;
        drum->drive = clampf01(read_param(params, "dist", 0.05f));
        drum->damp = 0.2f;
    } else if (idx == 1) {
        drum->body = clampf01(read_param(params, "body", 0.3f));
        drum->decay = snare_body_decay_seconds(read_param(params, "bdcy", 0.3f));
        drum->noise = clampf01(read_param(params, "noise", 0.5f));
        drum->noise_decay = snare_noise_decay_seconds(read_param(params, "ndcy", 0.3f));
        drum->click = clampf01(read_param(params, "snap", 0.4f));
        drum->tone = clampf01(read_param(params, "tone", 0.5f));
        drum->drive = clampf01(read_param(params, "dist", 0.1f));
        snare_pitch_bend(drum->body, &drum->bend, &drum->bend_time);
        drum->ratio = 1.4f + drum->body * 0.8f;
        drum->damp = 0;
    } else if (idx == 2) {
        drum->body = clampf01(read_param(params, "metal", 0.5f));
        drum->noise = clampf01(read_param(params, "noise", 0.5f));
        drum->tone = clampf01(read_param(params, "color", 0.5f));
        drum->decay = hat_decay_seconds(read_param(params, "decay", 0.3f));
        drum->noise_decay = drum->decay;
        drum->click = clampf01(read_param(params, "atk", 0.3f));
        drum->ring = clampf01(read_param(params, "ring", 0.3f));
        drum->pos = clampf01(read_param(params, "pos", 0.5f));
        drum->bend = 0;
        drum->bend_time = 0.05f;
    } else {
        drum->body = clampf01(read_param(params, "mat", 0.2f));
        drum->decay = perc_decay_seconds(read_param(params, "decay", 0.4f));
        drum->noise_decay = drum->decay * 0.4f;
        if (drum->noise_decay > 0.09f) drum->noise_decay = 0.09f;
        drum->bend = clampf01(read_param(params, "pbend", 0.1f)) * 3.5f;
        drum->bend_time = drum->decay * 0.7f;
        if (drum->bend_time < 0.03f) drum->bend_time = 0.03f;
        drum->fm = clampf01(read_param(params, "fm", 0.0f));
        drum->ratio = fm_ratio_of(read_param(params, "ratio", 0.06f));
        drum->click = clampf01(read_param(params, "atk", 0.3f));
        drum->damp = clampf01(read_param(params, "damp", 0.4f));
        drum->noise = perc_noise_amt(drum->body);
        drum->tone = perc_tone(drum->body);
    }
    drum->click_env = drum->click > 0.001f ? 1.0f : 0.0f;
    drum->cutoff = read_param(params, "cutoff", 0.5f);
    drum->resonance = read_param(params, "resonance", 0.0f);
    drum->reverb = read_param(params, "reverb", 0.0f);
    drum->delay = read_param(params, "delay", 0.0f);
    refresh_drum_env(drum);
}

/* Peaks above the passband squash into a thick acid tone instead of a spike. */

float clip_peak(float x) {
    float a = fabsf(x);
    if (a <= 1.25f) return x;
    float over = a - 1.25f;
    float y = 1.25f + over / (1.0f + over);
    return x < 0.0f ? -y : y;
}

/* 0.5 is dry. Below that a resonant high-pass, above it a resonant low-pass.
   Distance from center is squared. Resonance is the peak on that corner (Q up to 14). */

float filter_sample(float *low, float *band, FltCache *coef, float input, float cutoff, float resonance) {
    float offset = cutoff - 0.5f;
    float amount = fabsf(offset) * 2.0f;
    float shaped, hz, reso, q, g, k, a1, a2, a3, trim;
    int lp;
    float v3, v1, v2, raw;
    if (amount > 1.0f) amount = 1.0f;
    if (amount < 1e-4f) {
        *low = 0;
        *band = 0;
        if (coef) coef->on = 0;
        return input;
    }
    if (coef && coef->on && coef->cut == cutoff && coef->res == resonance) {
        a1 = coef->a1;
        a2 = coef->a2;
        a3 = coef->a3;
        k = coef->k;
        trim = coef->trim;
        lp = coef->lp;
    } else {
        shaped = amount * amount;
        lp = offset > 0.0f;
        hz = lp ? 12000.0f * powf(90.0f / 12000.0f, shaped) : 40.0f * powf(7000.0f / 40.0f, shaped);
        reso = resonance;
        if (reso < 0.0f) reso = 0.0f;
        if (reso > 1.0f) reso = 1.0f;
        q = 0.707f * powf(14.0f / 0.707f, reso);
        if (hz > SR * 0.45f) hz = SR * 0.45f;
        g = tanf((TWO_PI * 0.5f) * hz / SR);
        k = 1.0f / q;
        a1 = 1.0f / (1.0f + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
        trim = lp ? 1.0f + shaped * 0.5f : 1.0f + shaped * 2.5f;
        if (coef) {
            coef->on = 1;
            coef->cut = cutoff;
            coef->res = resonance;
            coef->a1 = a1;
            coef->a2 = a2;
            coef->a3 = a3;
            coef->k = k;
            coef->trim = trim;
            coef->lp = lp;
        }
    }
    v3 = input - *low;
    v1 = a1 * *band + a2 * v3;
    v2 = *low + a2 * *band + a3 * v3;
    *band = 2.0f * v1 - *band;
    *low = 2.0f * v2 - *low;
    raw = lp ? v2 : input - k * v1 - v2;
    return clip_peak(raw * trim);
}

static const float KICK_CENTER[5] = {0.08f, 0.28f, 0.5f, 0.78f, 0.96f};
static const float SNARE_CENTER[5] = {0.08f, 0.28f, 0.5f, 0.75f, 0.92f};
static const float PERC_CENTER[6] = {0.08f, 0.24f, 0.42f, 0.58f, 0.74f, 0.92f};
static const float KICK_SPEC[30] = {
    2, 0, 3, 0, 0, 0,
    1.59f, 0.48f, 2.2f, 0.14f, 0.1f, 0,
    3, 0.34f, 5, 0.16f, 0.22f, 0,
    3.4f, 0.95f, 5.2f, 0.62f, 0.08f, 0,
    2, 0.28f, 3.2f, 0.2f, 0.96f, 0,
};
static const float SNARE_SPEC[30] = {
    2, 0.02f, 3, 0, 0, 0,
    2, 0.92f, 4, 0.08f, 0, 0,
    2.29f, 0.58f, 3.71f, 0.36f, 0.1f, 0,
    2.76f, 0.64f, 5.4f, 0.42f, 0.12f, 0.45f,
    1.41f, 0.3f, 2, 0.18f, 0.2f, 1.7f,
};
static const float PERC_SPEC[36] = {
    1.7f, 0.36f, 2.4f, 0.1f, 0.05f, 0,
    2.3f, 0.52f, 3.6f, 0.3f, 0.08f, 0,
    1.48f, 0.88f, 2.2f, 0.42f, 0.04f, 0,
    2, 0.48f, 2.98f, 0.58f, 0.06f, 0.35f,
    2.71f, 0.72f, 4.2f, 0.52f, 0.1f, 0.55f,
    1, 0.12f, 1, 0, 0.12f, 2.5f,
};

float wrap_phase(float phase) {
    if (phase < TWO_PI) return phase;
    return phase - TWO_PI * floorf(phase / TWO_PI);
}

Spectrum spec_row(const float *table, int index) {
    int o = index * 6;
    Spectrum spec;
    spec.r2 = table[o];
    spec.a2 = table[o + 1];
    spec.r3 = table[o + 2];
    spec.a3 = table[o + 3];
    spec.shape = table[o + 4];
    spec.fm = table[o + 5];
    return spec;
}

Spectrum shelf_spec(const float *table, const float *centers, int n, float t) {
    float u = clampf01(t);
    int i;
    if (u <= centers[0]) return spec_row(table, 0);
    for (i = 0; i < n - 1; i++) {
        float left, right, f, s;
        Spectrum a, b, m;
        if (u > centers[i + 1]) continue;
        left = centers[i] + 0.06f;
        right = centers[i + 1] - 0.06f;
        if (right <= left || u <= left) return spec_row(table, i);
        if (u >= right) return spec_row(table, i + 1);
        f = (u - left) / (right - left);
        s = f * f * (3.0f - 2.0f * f);
        a = spec_row(table, i);
        b = spec_row(table, i + 1);
        m.r2 = a.r2 * (1.0f - s) + b.r2 * s;
        m.a2 = a.a2 * (1.0f - s) + b.a2 * s;
        m.r3 = a.r3 * (1.0f - s) + b.r3 * s;
        m.a3 = a.a3 * (1.0f - s) + b.a3 * s;
        m.shape = a.shape * (1.0f - s) + b.shape * s;
        m.fm = a.fm * (1.0f - s) + b.fm * s;
        return m;
    }
    return spec_row(table, n - 1);
}

void tonal_body(Drum *drum, float freq, float *mid, float *side) {
    Spectrum spec = drum->lane == 0
        ? shelf_spec(KICK_SPEC, KICK_CENTER, 5, drum->body)
        : drum->lane == 1
            ? shelf_spec(SNARE_SPEC, SNARE_CENTER, 5, drum->body)
            : shelf_spec(PERC_SPEC, PERC_CENTER, 6, drum->body);
    float a2 = spec.a2;
    float a3 = spec.a3;
    float dull = 1.0f;
    float inc, index, fm_mix, ratio, p1, p2, sine, bent, x, gain;
    if (drum->lane == 1) {
        float pair = 0.4f + drum->tone * 0.95f;
        float e = drum->env > 1e-4f ? drum->env : 1e-4f;
        float fall = powf(e, 0.7f);
        a2 *= pair * fall;
        a3 *= pair * (0.35f + drum->tone) * fall * fall;
    }
    if (drum->damp > 0.001f) {
        float e = drum->env > 1e-4f ? drum->env : 1e-4f;
        dull = powf(e, 1.0f + drum->damp * 6.0f);
        a2 *= dull;
        a3 *= dull * dull;
    }
    inc = (TWO_PI * freq) / SR;
    index = (drum->fm * 5.0f + spec.fm) * dull;
    fm_mix = index <= 0 ? 0 : index / 0.8f;
    if (fm_mix > 1.0f) fm_mix = 1.0f;
    if (drum->lane == 3) {
        float env = drum->env > 1e-4f ? drum->env : 1e-4f;
        float held = drum->damp > 0.001f ? powf(env, drum->damp * 1.5f) : 1.0f;
        float user = powf(drum->fm, 0.55f) * 5.5f;
        index = user * (0.15f + 0.85f * held) + spec.fm * dull;
        fm_mix = index <= 0 ? 0 : index / 0.65f;
        if (fm_mix > 1.0f) fm_mix = 1.0f;
    }
    ratio = spec.r3 * (1.0f - fm_mix) + drum->ratio * fm_mix;
    drum->phase0 = wrap_phase(drum->phase0 + inc);
    drum->phase1 = wrap_phase(drum->phase1 + inc * spec.r2);
    drum->phase2 = wrap_phase(drum->phase2 + inc * ratio);
    p1 = sinf(drum->phase1);
    p2 = sinf(drum->phase2);
    sine = sinf(drum->phase0);
    bent = sinf(drum->phase0 + p2 * index);
    x = sine * (1.0f - fm_mix) + bent * fm_mix + p1 * a2 * (1.0f - fm_mix * 0.45f) + p2 * a3 * (1.0f - fm_mix);
    if (drum->lane == 3) x += p2 * fm_mix * 0.2f;
    if (spec.shape > 0.001f) {
        float shaped = tanhf(x * (1.0f + spec.shape * 7.0f));
        x += (shaped - x) * spec.shape;
    }
    gain = drum->lane == 0 ? 0.85f : drum->lane == 1 ? 0.55f : 0.6f;
    *mid = x * gain;
    *side = 0;
}

void hat_body(Drum *drum, float freq, float *mid, float *side) {
    float m = clampf01(drum->body);
    float ring = drum->ring;
    float lo[4] = {1.0f, 2.02f, 2.97f, 4.05f};
    float hi[4] = {1.0f, 1.47f, 2.31f, 3.73f};
    float gain = m <= 0.06f ? 0 : (m - 0.06f) / 0.94f;
    float inc = (TWO_PI * freq) / SR;
    float s0, s1, s2, s3;
    drum->phase0 = wrap_phase(drum->phase0 + inc * (lo[0] * (1.0f - m) + hi[0] * m));
    drum->phase1 = wrap_phase(drum->phase1 + inc * (lo[1] * (1.0f - m) + hi[1] * m));
    drum->phase2 = wrap_phase(drum->phase2 + inc * (lo[2] * (1.0f - m) + hi[2] * m));
    drum->phase3 = wrap_phase(drum->phase3 + inc * (lo[3] * (1.0f - m) + hi[3] * m));
    s0 = sinf(drum->phase0) * 0.9f * gain;
    s1 = sinf(drum->phase1) * 0.72f * gain * (1.0f - ring * 0.35f);
    s2 = sinf(drum->phase2) * 0.5f * gain * (1.0f - ring * 0.6f);
    s3 = sinf(drum->phase3) * 0.36f * gain * (1.0f - ring * 0.8f);
    *mid = (s0 + s1 + s2 + s3) * 0.42f;
    *side = 0;
}

float noise_sample(Engine *engine, Drum *drum) {
    float white = rng(engine);
    float tilt, high;
    if (drum->lane == 1) {
        float tone = clampf01(drum->tone);
        float sounded = drum->freq * powf(2.0f, drum->bend * drum->pitch_env);
        float center, low, high_hz;
        if (sounded < 40.0f) sounded = 40.0f;
        center = sounded * (4.5f * powf(4.0f, tone));
        low = center * 0.5f;
        if (low < 140.0f) low = 140.0f;
        if (low > 5000.0f) low = 5000.0f;
        high_hz = center * 2.4f;
        if (high_hz < low * 2.0f) high_hz = low * 2.0f;
        if (high_hz > 14000.0f) high_hz = 14000.0f;
        drum->nlp += (white - drum->nlp) * pole_coef(high_hz);
        drum->nhp += (drum->nlp - drum->nhp) * pole_coef(low);
        return (drum->nlp - drum->nhp) * drum->noise * (3.6f + tone * 2.2f);
    }
    tilt = clampf01(drum->tone);
    drum->nlp += (white - drum->nlp) * (0.04f + tilt * 0.5f);
    drum->nhp += (white - drum->nhp) * (0.03f + tilt * 0.45f);
    high = white - drum->nhp;
    return (drum->nlp * (1.0f - tilt) + high * tilt) * drum->noise;
}

float transient_sample(Engine *engine, Drum *drum) {
    float u = drum->click;
    float env = drum->click_env;
    float burst, tick_w, pulse_w, chirp_w, chirp, tick;
    drum->click_env *= drum->click_k;
    burst = rng(engine);
    if (u < 0.001f || env < 1e-5f) return 0;
    if (drum->lane == 1) {
        float tick_only = 1.0f - fade01(u, 0.12f, 0.62f);
        float pulse = fade01(u, 0.08f, 0.55f);
        float crack_hz = 900.0f * powf(7500.0f / 900.0f, u);
        float coef = pole_coef(crack_hz);
        float crack, tick, sharp, level, tick_hz;
        drum->phase3 += (burst - drum->phase3) * coef;
        crack = drum->phase3 * (1.0f - u * 0.7f) + burst * (u * 0.7f);
        tick_hz = 600.0f + u * 3400.0f;
        drum->click_phase = wrap_phase(drum->click_phase + (TWO_PI * tick_hz) / SR);
        tick = sinf(drum->click_phase);
        sharp = powf(env, 1.0f + u * 0.8f);
        level = 0.75f + u * 0.45f;
        return (tick * tick_only * 0.8f + crack * pulse * 2.6f) * level * sharp;
    }
    if (drum->lane == 2) {
        float sharp = powf(env, 0.5f + u);
        return burst * u * 1.8f * sharp;
    }
    tick_w = 1.0f - fade01(u, 0.12f, 0.5f);
    pulse_w = fade01(u, 0.15f, 0.45f) * (1.0f - fade01(u, 0.55f, 0.9f));
    chirp_w = fade01(u, 0.4f, 0.8f);
    drum->click_phase = wrap_phase(drum->click_phase + (TWO_PI * (900.0f + 5200.0f * env)) / SR);
    chirp = sinf(drum->click_phase);
    tick = sinf(drum->click_phase * 0.45f);
    return (tick * tick_w + burst * env * env * pulse_w + chirp * chirp_w) * u * 1.15f * env;
}

float shape_drive(float sample, float drive) {
    float gain = 1.0f + drive * 8.0f;
    float driven = sample * gain;
    return driven / (1.0f + fabsf(driven));
}

void drum_sample(Engine *engine, Drum *drum, float *left, float *right) {
    float freq = drum->freq * powf(2.0f, drum->bend * drum->pitch_env);
    float mid = 0, side = 0, noisy, click, filtered;
    if (drum->lane == 2) hat_body(drum, freq, &mid, &side);
    else tonal_body(drum, freq, &mid, &side);
    noisy = noise_sample(engine, drum) * drum->noise_env;
    click = transient_sample(engine, drum) * drum->gain;
    mid = mid * drum->env + noisy + click;
    side *= drum->env;
    if (drum->drive > 1e-4f) {
        float amount = drum->drive * drum->drive;
        mid = shape_drive(mid, amount);
        side = shape_drive(side, amount);
    }
    filtered = filter_sample(&drum->flt, &drum->band, &drum->coef, mid, drum->cutoff, drum->resonance);
    drum->env *= drum->env_k;
    drum->noise_env *= drum->noise_k;
    drum->pitch_env *= drum->pitch_k;
    drum->age += 1;
    if (drum->env < 0.0008f && drum->noise_env < 0.0008f && drum->click_env < 0.0008f && drum->age > 64) drum->on = 0;
    if (drum->lane == 2) {
        float x = drum->pos;
        float gl, gr;
        if (x < 0.0f) x = 0.0f;
        if (x > 1.0f) x = 1.0f;
        gl = x <= 0.5f ? 1.0f : (1.0f - x) * 2.0f;
        gr = x >= 0.5f ? 1.0f : x * 2.0f;
        *left = filtered * gl;
        *right = filtered * gr;
        return;
    }
    *left = filtered + side;
    *right = filtered - side;
}
