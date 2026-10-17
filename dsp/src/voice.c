/*
 * ptnmove voice. One drum voice per lane and one shared note pool for
 * bass, lead and chords. Parameter ids match src/dsp/map.ts.
 * Own synth — libpo32 / Surge are not vendored; keys stay compatible with map.ts.
 */

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SR 44100.0f
#define TWO_PI 6.28318530718f
#define DRUMS 4
#define NOTES 12
#define TEXT_CAP 8192
#define PHRASE_TEXT 65536
#define PHRASE_CAP 512
#define LANE_COUNT 8
#define LANE_MOTION_CAP 12

enum {
    P_NONE = 0,
    P_FREQ,
    P_DCY,
    P_NEDCY,
    P_MIX,
    P_DIST,
    P_NFQ,
    P_PAN,
    P_MRATE,
    P_NFFRQ,
    P_ATK,
    P_MAMT,
    P_LVL,
    P_WAVE,
    P_BEND,
    P_SYNC,
    P_FOLD,
    P_CUTOFF,
    P_RESONANCE,
    P_ATTACK,
    P_RELEASE,
    P_WIDE,
    P_REVERB,
    P_DELAY,
    P_NOTE_DRIVE
};

typedef struct {
    int on;
    int lane;
    float phase, phase2, env, noise_env, freq, decay, noise_decay;
    float noise, drive, tone, pan, spread, snap, bright, bend, body, low, base;
    float cutoff, resonance, reverb, delay, flt, band;
    float env_k, noise_k, click_k, click_env, click_tau;
    int age, loop;
} Drum;

typedef struct {
    int on;
    float phase, phase2, slave, slave2, env, freq;
    float wave, bend, sync, fold, drive, wide;
    float cutoff, resonance, reverb, delay, attack, release, gain, low, band;
    float release_k;
    int age, left, lane, loop;
} Note;

typedef struct {
    int param;
    int pattern;
    float value, cycle, amount;
    int blend;
    int pattern_b;
    float value_b, cycle_b, amount_b, morph_t;
} LaneMotion;

typedef struct {
    int live_count;
    int still_count;
    LaneMotion live[LANE_MOTION_CAP];
    LaneMotion still[LANE_MOTION_CAP];
} LaneBox;

typedef struct {
    int sample;
    int loop;
    int lane;
    int note;
    int velocity;
    int ticks;
    char params[320];
} PhraseEv;

typedef struct {
    float *buf;
    int n;
    int i;
} Line;

typedef struct {
    Line pre, in0, in1, in2, in3, modL, modR, dL1, dL2, dR1, dR2, apL, apR;
    float dampL, dampR, lowL, lowR, right, lfo;
    int quiet;
    float size, decay, damp, diff, predelay, width, low, level;
} Plate;

typedef struct {
    Line l, r;
    float lpL, lpR, hpL, hpR, phase;
    int quiet;
    float time, feed, hi, lo, width, mod, rate, level;
} Echo;

typedef struct {
    uint32_t noise;
    float tempo;
    float beats;
    Plate plate;
    Echo echo;
    char block[TEXT_CAP];
    int has_block;
    char *phrase_text;
    int phrase_pending;
    int phrase_on;
    int phrase_count;
    int clock;
    unsigned phrase_sig;
    LaneBox lanes[LANE_COUNT];
    PhraseEv phrase[PHRASE_CAP];
    Drum drums[DRUMS];
    Note notes[NOTES];
} Engine;

typedef struct {
    uint32_t api_version;
    void *(*create_instance)(const char *module_dir, const char *json_defaults);
    void (*destroy_instance)(void *instance);
    void (*on_midi)(void *instance, const uint8_t *msg, int len, int source);
    void (*set_param)(void *instance, const char *key, const char *val);
    int (*get_param)(void *instance, const char *key, char *buf, int buf_len);
    int (*get_error)(void *instance, char *buf, int buf_len);
    void (*render_block)(void *instance, int16_t *out_interleaved_lr, int frames);
} plugin_api_v2_t;

static float rng(Engine *engine) {
    engine->noise = engine->noise * 1664525u + 1013904223u;
    return (float)engine->noise / 4294967296.0f * 2.0f - 1.0f;
}

static float read_param(const char *params, const char *suffix, float fallback) {
    if (!params || !params[0]) return fallback;
    const char *cursor = params;
    while (*cursor) {
        const char *eq = strchr(cursor, '=');
        if (!eq) break;
        const char *comma = strchr(eq, ',');
        int name_len = (int)(eq - cursor);
        int match = name_len >= (int)strlen(suffix) && strncmp(eq - strlen(suffix), suffix, strlen(suffix)) == 0;
        if (match && (name_len == (int)strlen(suffix) || cursor[name_len - (int)strlen(suffix) - 1] == '_' || name_len == (int)strlen(suffix))) {
            return strtof(eq + 1, NULL);
        }
        if (!comma) break;
        cursor = comma + 1;
    }
    return fallback;
}

static float soft(float sample) {
    float scaled = sample * 0.35f;
    return scaled / (1.0f + fabsf(scaled));
}

#define WT_FRAMES 48
#define WT_CYCLE 256
#define WT_MIPS 7
#define WT_HARM 64
static float wave_table[WT_MIPS * WT_FRAMES * WT_CYCLE];
static int wave_ready = 0;
static const float WT_ANCHOR[6] = {0.0f, 0.22f, 0.42f, 0.62f, 0.82f, 1.0f};

static float gauss_k(float k, float center, float sigma) {
    float d = (k - center) / sigma;
    return expf(-d * d);
}

static float anchor_amp(int kind, int k) {
    float kf = (float)k;
    if (kind == 0) return k == 1 ? 1.0f : 0.0f;
    if (kind == 1) {
        if ((k & 1) == 0) return 0.0f;
        return ((k % 4) == 1 ? 1.0f : -1.0f) / (kf * kf);
    }
    if (kind == 2) return 1.0f / kf;
    if (kind == 3) return (k & 1) ? 1.0f / kf : 0.0f;
    if (kind == 4) return sinf(3.14159265f * kf * 0.12f) / kf;
    return 0.22f / powf(kf, 1.5f) + gauss_k(kf, 3.0f, 0.9f) + 0.75f * gauss_k(kf, 8.0f, 1.2f) + 0.55f * gauss_k(kf, 14.0f, 1.5f);
}

static float amp_at(float p, int k) {
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

static void ensure_wave_table(void) {
    int mip, frame, k, n;
    if (wave_ready) return;
    for (mip = 0; mip < WT_MIPS; mip++) {
        int max_h = WT_HARM >> mip;
        for (frame = 0; frame < WT_FRAMES; frame++) {
            float p = (float)frame / (float)(WT_FRAMES - 1);
            float amp[WT_HARM + 1];
            float peak = 0.0f;
            int base = (mip * WT_FRAMES + frame) * WT_CYCLE;
            for (k = 1; k <= max_h; k++) amp[k] = amp_at(p, k);
            for (n = 0; n < WT_CYCLE; n++) {
                float theta = (TWO_PI * (float)n) / (float)WT_CYCLE;
                float sum = 0.0f;
                for (k = 1; k <= max_h; k++) sum += amp[k] * sinf((float)k * theta);
                wave_table[base + n] = sum;
                if (fabsf(sum) > peak) peak = fabsf(sum);
            }
            if (peak > 1e-8f) {
                float norm = 1.0f / peak;
                for (n = 0; n < WT_CYCLE; n++) wave_table[base + n] *= norm;
            }
        }
    }
    wave_ready = 1;
}

static float read_cycle(int mip, int frame, float u) {
    float pos = u * (float)WT_CYCLE;
    int i0 = (int)floorf(pos) % WT_CYCLE;
    float frac = pos - floorf(pos);
    int i1 = (i0 + 1) % WT_CYCLE;
    int base = (mip * WT_FRAMES + frame) * WT_CYCLE;
    float a = wave_table[base + i0];
    float b = wave_table[base + i1];
    return a + (b - a) * frac;
}

static float read_wave(float freq, float wave, float u) {
    float fit = (SR * 0.45f) / (freq > 1.0f ? freq : 1.0f);
    float mip_f, pos, ff, s0, s1;
    int m0, m1, top, f0;
    if (fit < 1.0f) fit = 1.0f;
    if (fit > (float)WT_HARM) fit = (float)WT_HARM;
    mip_f = logf((float)WT_HARM / fit) / logf(2.0f);
    m0 = (int)floorf(mip_f);
    if (m0 < 0) m0 = 0;
    if (m0 > WT_MIPS - 1) m0 = WT_MIPS - 1;
    top = m0 >= WT_MIPS - 1;
    m1 = top ? m0 : m0 + 1;
    pos = wave < 0.0f ? 0.0f : (wave > 1.0f ? 1.0f : wave);
    pos *= (float)(WT_FRAMES - 1);
    f0 = (int)floorf(pos);
    if (f0 >= WT_FRAMES - 1) f0 = WT_FRAMES - 2;
    ff = pos - (float)f0;
    s0 = read_cycle(m0, f0, u) * (1.0f - ff) + read_cycle(m0, f0 + 1, u) * ff;
    if (top || mip_f - (float)m0 < 1e-4f) return s0;
    s1 = read_cycle(m1, f0, u) * (1.0f - ff) + read_cycle(m1, f0 + 1, u) * ff;
    return s0 + (s1 - s0) * (mip_f - (float)m0);
}

static float bend_unit(float u, float bend) {
    if (bend <= 1e-4f || u <= 0.0f) return u;
    return powf(u, 1.0f + bend * bend * 3.0f);
}

static float advance_osc(Note *note, int wide, float inc, float sync, float bend, float wave) {
    float *phase = wide ? &note->phase2 : &note->phase;
    float *slave = wide ? &note->slave2 : &note->slave;
    float next = *phase + inc;
    int wrapped = 0;
    float u, read_freq;
    if (next >= TWO_PI) {
        next -= TWO_PI;
        if (next >= TWO_PI) next = fmodf(next, TWO_PI);
        wrapped = 1;
    }
    *phase = next;
    if (sync > 1e-4f) {
        float ratio = 1.0f + sync * sync * 4.0f;
        if (wrapped) *slave = 0.0f;
        else {
            *slave += inc * ratio;
            if (*slave >= TWO_PI) *slave = fmodf(*slave, TWO_PI);
        }
        u = *slave / TWO_PI;
        read_freq = (inc * ratio * SR) / TWO_PI;
    } else {
        u = *phase / TWO_PI;
        read_freq = (inc * SR) / TWO_PI;
    }
    return read_wave(read_freq, wave, bend_unit(u, bend));
}

static int suffix_is(const char *id, const char *suffix) {
    int n = (int)strlen(id);
    int s = (int)strlen(suffix);
    if (n < s) return 0;
    if (strcmp(id + n - s, suffix) != 0) return 0;
    return n == s || id[n - s - 1] == '_';
}

static float wrap01(float phase) {
    float wrapped = phase - floorf(phase);
    if (wrapped < 0) wrapped += 1.0f;
    return wrapped;
}

static float clampf01(float value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

/* Squared unit → seconds: low end stays clicky, top still reaches ~1 s. */
static float drum_decay_seconds(float unit) {
    float u = clampf01(unit);
    return 0.005f + u * u * 0.95f;
}

static float drum_noise_decay_seconds(float unit) {
    float u = clampf01(unit);
    return 0.004f + u * u * 0.86f;
}

static float euclid_gate(int steps, int pulses, float phase) {
    int idx = (int)floorf(phase * (float)steps) % steps;
    if (idx < 0) idx += steps;
    int hits = pulses < 1 ? 1 : pulses;
    if (hits > steps) hits = steps;
    for (int p = 0; p < hits; p++) {
        if ((p * steps) / hits == idx) return 1.0f;
    }
    return -1.0f;
}

static float motif_at(int id, float phase01) {
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

static int param_of(const char *id) {
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
    if (suffix_is(id, "freq")) return P_FREQ;
    if (suffix_is(id, "nedcy")) return P_NEDCY;
    if (suffix_is(id, "nffrq")) return P_NFFRQ;
    if (suffix_is(id, "mrate")) return P_MRATE;
    if (suffix_is(id, "mamt")) return P_MAMT;
    if (suffix_is(id, "dcy")) return P_DCY;
    if (suffix_is(id, "mix")) return P_MIX;
    if (suffix_is(id, "dist")) return P_DIST;
    if (suffix_is(id, "nfq")) return P_NFQ;
    if (suffix_is(id, "pan")) return P_PAN;
    if (suffix_is(id, "atk")) return P_ATK;
    if (suffix_is(id, "lvl")) return P_LVL;
    return P_NONE;
}

static float eval_one(float value, int pattern, float cycle, float amount, float step) {
    if (amount == 0.0f) return clampf01(value);
    int length = (int)roundf(cycle);
    if (length < 1) length = 1;
    float wrapped = fmodf(step, (float)length);
    if (wrapped < 0) wrapped += (float)length;
    return clampf01(value + motif_at(pattern, wrapped / (float)length) * amount);
}

static float eval_lane(const LaneMotion *motion, float step) {
    float a = eval_one(motion->value, motion->pattern, motion->cycle, motion->amount, step);
    if (!motion->blend) return a;
    float b = eval_one(motion->value_b, motion->pattern_b, motion->cycle_b, motion->amount_b, step);
    float t = motion->morph_t;
    if (t < 0.0f) t = 0.0f;
    if (t > 1.0f) t = 1.0f;
    return clampf01((1.0f - t) * a + t * b);
}

static void refresh_drum_env(Drum *drum) {
    float dcy = drum->decay < 0.004f ? 0.004f : drum->decay;
    float ndcy = drum->noise_decay < 0.003f ? 0.003f : drum->noise_decay;
    drum->env_k = expf(-1.0f / (dcy * SR));
    drum->noise_k = expf(-1.0f / (ndcy * SR));
}

static void refresh_click(Drum *drum) {
    float tau = 10.0f + drum->snap * 160.0f + (1.0f - drum->bright) * 260.0f;
    if (tau < 1.0f) tau = 1.0f;
    drum->click_tau = tau;
    drum->click_k = expf(-1.0f / tau);
}

static void refresh_release(Note *note) {
    note->release_k = expf(-1.0f / ((0.04f + note->release * 1.6f) * SR));
}

static void apply_drum(Drum *drum, int param, float unit) {
    switch (param) {
    case P_DCY:
        drum->decay = drum_decay_seconds(unit);
        if (drum->lane == 2) drum->noise_decay = drum_noise_decay_seconds(unit);
        refresh_drum_env(drum);
        break;
    case P_NEDCY:
        drum->noise_decay = drum_noise_decay_seconds(unit);
        refresh_drum_env(drum);
        break;
    case P_MIX: drum->noise = unit; break;
    case P_DIST: drum->drive = unit; break;
    case P_NFQ: drum->tone = unit; break;
    case P_PAN: drum->pan = unit; break;
    case P_MRATE: drum->spread = unit; break;
    case P_NFFRQ:
        drum->bright = unit;
        refresh_click(drum);
        break;
    case P_ATK:
        drum->snap = unit;
        refresh_click(drum);
        break;
    case P_MAMT: drum->bend = unit; break;
    case P_LVL: drum->body = unit; break;
    case P_CUTOFF: drum->cutoff = unit; break;
    case P_RESONANCE: drum->resonance = unit; break;
    case P_REVERB: drum->reverb = unit; break;
    case P_DELAY: drum->delay = unit; break;
    default: break;
    }
}

static void apply_note(Note *note, int param, float unit) {
    switch (param) {
    case P_WAVE: note->wave = unit; break;
    case P_BEND: note->bend = unit; break;
    case P_SYNC: note->sync = unit; break;
    case P_FOLD: note->fold = unit; break;
    case P_NOTE_DRIVE: note->drive = unit; break;
    case P_CUTOFF: note->cutoff = unit; break;
    case P_RESONANCE: note->resonance = unit; break;
    case P_REVERB: note->reverb = unit; break;
    case P_DELAY: note->delay = unit; break;
    case P_ATTACK: note->attack = unit; break;
    case P_RELEASE:
        note->release = unit;
        refresh_release(note);
        break;
    case P_WIDE: note->wide = unit; break;
    default: break;
    }
}

static void stamp_note(Engine *engine, Note *note) {
    if (note->lane < DRUMS || note->lane >= LANE_COUNT) return;
    LaneBox *box = &engine->lanes[note->lane];
    for (int m = 0; m < box->still_count; m++) apply_note(note, box->still[m].param, clampf01(box->still[m].value));
}

static void stamp_held(Engine *engine) {
    for (int n = 0; n < NOTES; n++) {
        if (engine->notes[n].on) stamp_note(engine, &engine->notes[n]);
    }
}

static void follow_sound(Engine *engine) {
    if (engine->clock < 1) return;
    float tempo = engine->tempo > 1.0f ? engine->tempo : 120.0f;
    float span = roundf((48.0f * SR * 60.0f) / (tempo * 192.0f));
    if (span < 1.0f) span = 1.0f;
    int pos = engine->clock - 1;
    for (int lane = 0; lane < LANE_COUNT; lane++) {
        LaneBox *box = &engine->lanes[lane];
        if (!box->live_count) continue;
        int loop = 0;
        if (lane < DRUMS) {
            Drum *drum = &engine->drums[lane];
            if (drum->on && drum->loop > 0) loop = drum->loop;
        } else {
            for (int n = 0; n < NOTES; n++) {
                Note *note = &engine->notes[n];
                if (note->on && note->lane == lane && note->loop > 0) {
                    loop = note->loop;
                    break;
                }
            }
        }
        if (loop < 1) continue;
        float step = (float)(pos % loop) / span;
        float units[LANE_MOTION_CAP];
        for (int m = 0; m < box->live_count; m++) units[m] = eval_lane(&box->live[m], step);
        if (lane < DRUMS) {
            Drum *drum = &engine->drums[lane];
            for (int m = 0; m < box->live_count; m++) apply_drum(drum, box->live[m].param, units[m]);
        } else {
            for (int n = 0; n < NOTES; n++) {
                Note *note = &engine->notes[n];
                if (!note->on || note->lane != lane || note->loop < 1) continue;
                for (int m = 0; m < box->live_count; m++) apply_note(note, box->live[m].param, units[m]);
            }
        }
    }
}

static void arm_drum(Engine *engine, int lane, int note, int velocity, const char *params, int loop) {
    int idx = lane < DRUMS ? lane : 0;
    Drum *drum = &engine->drums[idx];
    int hat = idx == 2;
    float pitch = read_param(params, "freq", 0.5f);
    float base = 440.0f * powf(2.0f, ((float)note - 69.0f) / 12.0f);
    float dropped = idx == 0 ? 0.5f : 1.0f;
    float vel = velocity / 127.0f;
    drum->on = 1;
    drum->lane = idx;
    drum->phase = 0;
    drum->phase2 = 0;
    drum->env = vel;
    drum->noise_env = vel;
    drum->age = 0;
    drum->base = base * dropped;
    drum->freq = drum->base * (0.5f + pitch);
    drum->loop = loop;
    float dcy_unit = read_param(params, "dcy", 0.5f);
    drum->decay = drum_decay_seconds(dcy_unit);
    /* Hat has no tail knob — keep noise decay on the same throw as body decay. */
    drum->noise_decay = drum_noise_decay_seconds(read_param(params, "nedcy", hat ? dcy_unit : 0.45f));
    drum->noise = read_param(params, "mix", hat ? 0.35f : (idx == 1 ? 0.55f : 0.15f));
    drum->drive = read_param(params, "dist", 0.15f);
    drum->tone = read_param(params, "nfq", hat ? 0.75f : 0.45f);
    drum->pan = read_param(params, "pan", 0.5f);
    drum->spread = read_param(params, "mrate", hat ? 0.4f : 0.1f);
    drum->snap = read_param(params, "atk", idx == 0 ? 0.35f : (hat ? 0.25f : 0.45f));
    drum->bright = read_param(params, "nffrq", hat ? 0.7f : 0.4f);
    drum->bend = read_param(params, "mamt", idx == 0 ? 0.55f : (idx == 3 ? 0.35f : 0.1f));
    drum->body = read_param(params, "lvl", hat ? 0.12f : 1.0f);
    drum->cutoff = read_param(params, "cutoff", 0.5f);
    drum->resonance = read_param(params, "resonance", 0.0f);
    drum->reverb = read_param(params, "reverb", 0.0f);
    drum->delay = read_param(params, "delay", 0.0f);
    drum->low = 0;
    drum->flt = 0;
    drum->band = 0;
    drum->click_env = 1.0f;
    refresh_drum_env(drum);
    refresh_click(drum);
    (void)engine;
    (void)lane;
}

static Note *steal(Engine *engine) {
    Note *quiet = &engine->notes[0];
    for (int i = 0; i < NOTES; i++) {
        if (!engine->notes[i].on) return &engine->notes[i];
        if (engine->notes[i].env < quiet->env) quiet = &engine->notes[i];
    }
    return quiet;
}

static Note *arm_note(Engine *engine, int note_num, int velocity, int ticks, const char *params, int lane, int loop) {
    Note *note = steal(engine);
    float tempo = engine->tempo > 1.0f ? engine->tempo : 120.0f;
    int samples = (int)((ticks * SR * 60.0f) / (tempo * 192.0f));
    if (samples < 1) samples = 1;
    note->on = 1;
    note->phase = 0;
    note->phase2 = 0;
    note->slave = 0;
    note->slave2 = 0;
    note->env = 0;
    note->age = 0;
    note->left = samples;
    note->lane = lane;
    note->loop = loop;
    note->freq = 440.0f * powf(2.0f, ((float)note_num - 69.0f) / 12.0f);
    note->wave = read_param(params, "wave", 0.36f);
    note->bend = read_param(params, "bend", 0.0f);
    note->sync = read_param(params, "sync", 0.0f);
    note->fold = read_param(params, "fold", 0.0f);
    note->drive = read_param(params, "drive", 0.0f);
    note->cutoff = read_param(params, "cutoff", 0.5f);
    note->resonance = read_param(params, "resonance", 0.0f);
    note->reverb = read_param(params, "reverb", 0.0f);
    note->delay = read_param(params, "delay", 0.0f);
    note->attack = read_param(params, "attack", 0.0f);
    note->release = read_param(params, "release", read_param(params, "decay", 0.4f));
    note->wide = read_param(params, "wide", 0.0f);
    note->gain = velocity / 127.0f;
    note->low = 0;
    note->band = 0;
    refresh_release(note);
    stamp_note(engine, note);
    return note;
}

/* Peaks above the passband squash into a thick acid tone instead of a spike. */
static float clip_peak(float x) {
    float a = fabsf(x);
    if (a <= 1.25f) return x;
    float over = a - 1.25f;
    float y = 1.25f + over / (1.0f + over);
    return x < 0.0f ? -y : y;
}

/* 0.5 is dry. Below that a resonant high-pass, above it a resonant low-pass.
   Distance from center is squared. Resonance is the peak on that corner (Q up to 14). */
static float filter_sample(float *low, float *band, float input, float cutoff, float resonance) {
    float offset = cutoff - 0.5f;
    float amount = fabsf(offset) * 2.0f;
    if (amount > 1.0f) amount = 1.0f;
    if (amount < 1e-4f) {
        *low = 0;
        *band = 0;
        return input;
    }
    float shaped = amount * amount;
    int lp = offset > 0.0f;
    float hz = lp ? 12000.0f * powf(90.0f / 12000.0f, shaped) : 40.0f * powf(7000.0f / 40.0f, shaped);
    float reso = resonance;
    if (reso < 0.0f) reso = 0.0f;
    if (reso > 1.0f) reso = 1.0f;
    float q = 0.707f * powf(14.0f / 0.707f, reso);
    float nyq = SR * 0.45f;
    if (hz > nyq) hz = nyq;
    float g = tanf((TWO_PI * 0.5f) * hz / SR);
    float k = 1.0f / q;
    float a1 = 1.0f / (1.0f + g * (g + k));
    float a2 = g * a1;
    float a3 = g * a2;
    float v3 = input - *low;
    float v1 = a1 * *band + a2 * v3;
    float v2 = *low + a2 * *band + a3 * v3;
    *band = 2.0f * v1 - *band;
    *low = 2.0f * v2 - *low;
    float raw = lp ? v2 : input - k * v1 - v2;
    float trim = lp ? 1.0f + shaped * 0.5f : 1.0f + shaped * 2.5f;
    return clip_peak(raw * trim);
}

static float drum_sample(Engine *engine, Drum *drum) {
    int kick = drum->lane == 0;
    int hat = drum->lane == 2;
    float bend = 1.0f + drum->bend * drum->env * (kick ? 4.5f : 2.2f);
    float inc = (TWO_PI * drum->freq * bend) / SR;
    float spread_mul = hat ? 1.8f + drum->bright * 2.4f : 0.08f + drum->spread * 0.25f;
    drum->phase += inc;
    drum->phase2 += inc * (1.0f + drum->spread * (hat ? 2.5f : 0.12f) + (hat ? drum->bright * 0.55f : 0.0f));
    float body = (sinf(drum->phase) + sinf(drum->phase2) * spread_mul) * drum->body;
    float click = rng(engine) * drum->click_env * drum->snap * (0.35f + drum->bright * 1.4f);
    float noisy = rng(engine) * drum->noise * (hat ? 0.45f + drum->bright * 0.7f : 1.0f);
    float mixed = body * drum->env + noisy * drum->noise_env + click;
    float coef = 0.025f + drum->tone * drum->tone * 0.95f;
    drum->low += (mixed - drum->low) * coef;
    /* Squared drive: useful throw stays audible; top of knob is the smash. */
    float drive = drum->drive * drum->drive;
    float gain = 1.0f + drive * 8.0f;
    float driven = drum->low * gain;
    driven = driven / (1.0f + fabsf(driven));
    float filtered = filter_sample(&drum->flt, &drum->band, driven, drum->cutoff, drum->resonance);
    drum->env *= drum->env_k;
    drum->noise_env *= drum->noise_k;
    drum->click_env *= drum->click_k;
    drum->age += 1;
    if (drum->env < 0.0008f && drum->noise_env < 0.0008f && (float)drum->age > drum->click_tau * 4.0f) drum->on = 0;
    return filtered;
}

static void note_sample(Engine *engine, Note *note, float *left, float *right) {
    float inc = (TWO_PI * note->freq) / SR;
    float primary, mix, side = 0.0f, resonated, attack_samples, gain, sided;
    (void)engine;
    ensure_wave_table();
    primary = advance_osc(note, 0, inc, note->sync, note->bend, note->wave);
    mix = primary;
    if (note->wide > 1e-4f) {
        float ratio = powf(2.0f, (note->wide * 15.0f) / 1200.0f);
        float second = advance_osc(note, 1, inc * ratio, note->sync, note->bend, note->wave);
        float w = note->wide;
        mix = primary * (1.0f - w * 0.5f) + second * (w * 0.5f);
        side = (primary - second) * w * 0.5f;
    }
    if (note->fold > 1e-4f) {
        float folded = sinf(mix * (1.0f + note->fold * note->fold * 4.0f));
        mix += (folded - mix) * note->fold;
    }
    if (note->drive > 1e-4f) {
        float amount = note->drive * note->drive * 5.0f;
        float driven = mix * (1.0f + amount);
        mix = driven / (1.0f + amount * fabsf(mix));
    }
    resonated = filter_sample(&note->low, &note->band, mix, note->cutoff, note->resonance);
    attack_samples = 1.0f + note->attack * 0.2f * SR;
    /* Hold full level for the whole note. Release is the tail after that length. */
    if (note->left > 0 && (float)note->age < attack_samples) note->env = ((float)note->age + 1.0f) / attack_samples;
    else if (note->left > 0) note->env = 1.0f;
    else note->env *= note->release_k;
    note->age += 1;
    if (note->left > 0) note->left -= 1;
    /* Slow attacks start below 0.0008; only silence once the gate is over and the tail is quiet. */
    if (note->left <= 0 && (float)note->age >= attack_samples && note->env < 0.0008f) note->on = 0;
    gain = resonated * note->env * note->gain * 0.38f;
    sided = side * note->env * note->gain * 0.38f;
    *left += gain + sided;
    *right += gain - sided;
}

static void push_lane(Engine *engine, int lane, int param, float value, int pattern, float cycle, float amount,
    int blend, float value_b, int pattern_b, float cycle_b, float amount_b, float morph_t) {
    if (lane < 0 || lane >= LANE_COUNT || param == P_NONE || param == P_FREQ) return;
    LaneBox *box = &engine->lanes[lane];
    int live = amount != 0.0f || (blend && amount_b != 0.0f);
    int *count = live ? &box->live_count : &box->still_count;
    if (*count >= LANE_MOTION_CAP) return;
    LaneMotion *slot = live ? &box->live[*count] : &box->still[*count];
    slot->param = param;
    slot->pattern = pattern;
    slot->value = value;
    slot->cycle = cycle;
    slot->amount = amount;
    slot->blend = live && blend;
    slot->pattern_b = pattern_b;
    slot->value_b = value_b;
    slot->cycle_b = cycle_b;
    slot->amount_b = amount_b;
    slot->morph_t = morph_t;
    (*count)++;
}

static unsigned phrase_timing_sig(const Engine *engine);
static void catch_holding(Engine *engine);

static int line_make(Line *line, int n) {
    line->buf = (float *)calloc((size_t)n, sizeof(float));
    line->n = line->buf ? n : 0;
    line->i = 0;
    return line->buf != NULL;
}

static void line_free(Line *line) {
    free(line->buf);
    line->buf = NULL;
    line->n = 0;
    line->i = 0;
}

static void line_clear(Line *line) {
    if (!line->buf || line->n < 1) return;
    memset(line->buf, 0, (size_t)line->n * sizeof(float));
    line->i = 0;
}

static float line_read(const Line *line, float delay) {
    int n = line->n;
    if (n < 3) return 0.0f;
    if (delay < 1.0f) delay = 1.0f;
    float maxd = (float)(n - 2);
    if (delay > maxd) delay = maxd;
    float pos = (float)line->i - delay;
    while (pos < 0.0f) pos += (float)n;
    int i0 = (int)pos;
    if (i0 >= n) i0 %= n;
    float frac = pos - floorf(pos);
    int i1 = i0 + 1;
    if (i1 >= n) i1 = 0;
    return line->buf[i0] * (1.0f - frac) + line->buf[i1] * frac;
}

static void line_write(Line *line, float x) {
    if (x > -1e-15f && x < 1e-15f) x = 0.0f;
    line->buf[line->i] = x;
    if (++line->i >= line->n) line->i = 0;
}

static float line_ap(Line *line, float delay, float x, float g) {
    float z = line_read(line, delay);
    float y = -g * x + z;
    line_write(line, x + g * y);
    return y;
}

static float line_delay(Line *line, float samples, float x) {
    float y = line_read(line, samples);
    line_write(line, x);
    return y;
}

static float paper_scale(void) { return SR / 29761.0f; }

static int tank_len(float base) {
    return (int)ceilf(base * paper_scale() * 1.85f) + 32;
}

static float sized_delay(float base, float size) {
    return base * paper_scale() * (0.5f + size * 1.3f);
}

static int space_init(Engine *engine) {
    Plate *p = &engine->plate;
    Echo *e = &engine->echo;
    float s = paper_scale();
    int ok = 1;
    ok = line_make(&p->pre, (int)ceilf(SR * 0.2f) + 8) && ok;
    ok = line_make(&p->in0, (int)ceilf(142.0f * s) + 8) && ok;
    ok = line_make(&p->in1, (int)ceilf(107.0f * s) + 8) && ok;
    ok = line_make(&p->in2, (int)ceilf(379.0f * s) + 8) && ok;
    ok = line_make(&p->in3, (int)ceilf(277.0f * s) + 8) && ok;
    ok = line_make(&p->modL, tank_len(672.0f)) && ok;
    ok = line_make(&p->modR, tank_len(908.0f)) && ok;
    ok = line_make(&p->dL1, tank_len(4453.0f)) && ok;
    ok = line_make(&p->dL2, tank_len(3720.0f)) && ok;
    ok = line_make(&p->dR1, tank_len(4217.0f)) && ok;
    ok = line_make(&p->dR2, tank_len(3163.0f)) && ok;
    ok = line_make(&p->apL, tank_len(1800.0f)) && ok;
    ok = line_make(&p->apR, tank_len(2656.0f)) && ok;
    ok = line_make(&e->l, (int)ceilf(SR * 2.0f) + 8) && ok;
    ok = line_make(&e->r, (int)ceilf(SR * 2.0f) + 8) && ok;
    p->size = 0.45f;
    p->decay = 0.55f;
    p->damp = 0.4f;
    p->diff = 0.7f;
    p->predelay = 0.08f;
    p->width = 0.85f;
    p->low = 0.25f;
    p->level = 0.75f;
    e->time = 0.4f;
    e->feed = 0.4f;
    e->hi = 0.65f;
    e->lo = 0.12f;
    e->width = 0.55f;
    e->mod = 0.12f;
    e->rate = 0.3f;
    e->level = 0.7f;
    engine->beats = 4.0f;
    return ok;
}

static void space_free(Engine *engine) {
    Plate *p = &engine->plate;
    line_free(&p->pre);
    line_free(&p->in0);
    line_free(&p->in1);
    line_free(&p->in2);
    line_free(&p->in3);
    line_free(&p->modL);
    line_free(&p->modR);
    line_free(&p->dL1);
    line_free(&p->dL2);
    line_free(&p->dR1);
    line_free(&p->dR2);
    line_free(&p->apL);
    line_free(&p->apR);
    line_free(&engine->echo.l);
    line_free(&engine->echo.r);
}

static void space_clear(Engine *engine) {
    Plate *p = &engine->plate;
    line_clear(&p->pre);
    line_clear(&p->in0);
    line_clear(&p->in1);
    line_clear(&p->in2);
    line_clear(&p->in3);
    line_clear(&p->modL);
    line_clear(&p->modR);
    line_clear(&p->dL1);
    line_clear(&p->dL2);
    line_clear(&p->dR1);
    line_clear(&p->dR2);
    line_clear(&p->apL);
    line_clear(&p->apR);
    p->dampL = 0;
    p->dampR = 0;
    p->lowL = 0;
    p->lowR = 0;
    p->right = 0;
    p->lfo = 0;
    p->quiet = 0;
    line_clear(&engine->echo.l);
    line_clear(&engine->echo.r);
    engine->echo.lpL = 0;
    engine->echo.lpR = 0;
    engine->echo.hpL = 0;
    engine->echo.hpR = 0;
    engine->echo.phase = 0;
    engine->echo.quiet = 0;
}

static void apply_space(Engine *engine, const char *text) {
    float v[17];
    int n = 0;
    const char *cursor = text;
    while (n < 17 && cursor && *cursor) {
        char *end = NULL;
        float value = strtof(cursor, &end);
        if (end == cursor) break;
        v[n++] = value;
        cursor = (*end == ',') ? end + 1 : end;
    }
    if (n < 16) return;
    Plate *p = &engine->plate;
    Echo *e = &engine->echo;
    p->size = clampf01(v[0]);
    p->decay = clampf01(v[1]);
    p->damp = clampf01(v[2]);
    p->diff = clampf01(v[3]);
    p->predelay = clampf01(v[4]);
    p->width = clampf01(v[5]);
    p->low = clampf01(v[6]);
    p->level = clampf01(v[7]);
    e->time = clampf01(v[8]);
    e->feed = clampf01(v[9]);
    e->hi = clampf01(v[10]);
    e->lo = clampf01(v[11]);
    e->width = clampf01(v[12]);
    e->mod = clampf01(v[13]);
    e->rate = clampf01(v[14]);
    e->level = clampf01(v[15]);
    if (n >= 17 && v[16] >= 1.0f) engine->beats = v[16];
}

static float smooth_pole(float state, float x, float coef) {
    return state + (x - state) * coef;
}

static void plate_sample(Engine *engine, float inL, float inR, float *outL, float *outR) {
    Plate *p = &engine->plate;
    float energy = fabsf(inL) + fabsf(inR);
    if (energy < 1e-7f && p->quiet > (int)(SR / 2.0f)) {
        *outL = 0;
        *outR = 0;
        return;
    }
    float s = paper_scale();
    float pre = line_delay(&p->pre, fmaxf(1.0f, p->predelay * 0.2f * SR), (inL + inR) * 0.5f);
    float diffuse = 0.25f + p->diff * 0.5f;
    float x = pre;
    x = line_ap(&p->in0, 142.0f * s, x, diffuse);
    x = line_ap(&p->in1, 107.0f * s, x, diffuse);
    x = line_ap(&p->in2, 379.0f * s, x, diffuse);
    x = line_ap(&p->in3, 277.0f * s, x, diffuse);
    float decay = 0.25f + p->decay * 0.7f;
    p->lfo += (3.14159265f * 1.6f) / SR;
    if (p->lfo > 6.2831853f) p->lfo -= 6.2831853f;
    float wobble = sinf(p->lfo) * 12.0f * s;
    float left = x + p->right * decay;
    left = line_ap(&p->modL, sized_delay(672.0f, p->size) + wobble, left, 0.7f);
    float body = line_delay(&p->dL1, sized_delay(4453.0f, p->size), left);
    p->dampL = smooth_pole(p->dampL, body, 0.8f - p->damp * 0.75f);
    p->lowL = smooth_pole(p->lowL, p->dampL, 0.002f + p->low * 0.03f);
    body = (p->dampL * (1.0f - p->low) + (p->dampL - p->lowL) * p->low) * decay;
    left = line_ap(&p->apL, sized_delay(1800.0f, p->size), body, 0.5f);
    float left_last = line_delay(&p->dL2, sized_delay(3720.0f, p->size), left);
    float right = x + left_last * decay;
    right = line_ap(&p->modR, sized_delay(908.0f, p->size) - wobble, right, 0.7f);
    body = line_delay(&p->dR1, sized_delay(4217.0f, p->size), right);
    p->dampR = smooth_pole(p->dampR, body, 0.8f - p->damp * 0.75f);
    p->lowR = smooth_pole(p->lowR, p->dampR, 0.002f + p->low * 0.03f);
    body = (p->dampR * (1.0f - p->low) + (p->dampR - p->lowR) * p->low) * decay;
    right = line_ap(&p->apR, sized_delay(2656.0f, p->size), body, 0.5f);
    p->right = line_delay(&p->dR2, sized_delay(3163.0f, p->size), right);
    float mid = (left_last + p->right) * 0.5f;
    float side = (left_last - p->right) * 0.5f * p->width;
    *outL = (mid + side) * p->level;
    *outR = (mid - side) * p->level;
    p->quiet = energy + fabsf(*outL) + fabsf(*outR) < 1e-6f ? p->quiet + 1 : 0;
}

static float echo_color(Echo *e, int right, float x) {
    float hi = 0.05f + e->hi * 0.95f;
    float *lp = right ? &e->lpR : &e->lpL;
    float *hp = right ? &e->hpR : &e->hpL;
    *lp = smooth_pole(*lp, x, hi);
    *hp = smooth_pole(*hp, *lp, 0.001f + e->lo * 0.08f);
    return *lp * (1.0f - e->lo) + (*lp - *hp) * e->lo;
}

static void echo_sample(Engine *engine, float inL, float inR, float *outL, float *outR) {
    Echo *e = &engine->echo;
    float energy = fabsf(inL) + fabsf(inR);
    if (energy < 1e-7f && e->quiet > (int)(SR / 2.0f)) {
        *outL = 0;
        *outR = 0;
        return;
    }
    float bar = engine->beats > 1.0f ? engine->beats : 1.0f;
    float unit = clampf01(e->time);
    float seconds = 0.125f * powf(bar / 0.125f, unit) * 60.0f / (engine->tempo > 1.0f ? engine->tempo : 1.0f);
    if (seconds > 2.0f) seconds = 2.0f;
    if (seconds < 0.001f) seconds = 0.001f;
    e->phase += (6.2831853f * (0.05f + e->rate * 4.0f)) / SR;
    if (e->phase > 6.2831853f) e->phase -= 6.2831853f;
    float samples = seconds * SR + sinf(e->phase) * e->mod * 0.008f * SR;
    float stereo = e->width * 2.0f;
    if (stereo > 1.0f) stereo = 1.0f;
    float ping = e->width * 2.0f - 1.0f;
    if (ping < 0.0f) ping = 0.0f;
    float mono = (inL + inR) * 0.5f;
    float srcL = mono * (1.0f - stereo) + inL * stereo;
    float srcR = mono * (1.0f - stereo) + inR * stereo;
    float delL = line_read(&e->l, samples);
    float delR = line_read(&e->r, samples);
    float feed = e->feed * 0.92f;
    line_write(&e->l, srcL + echo_color(e, 0, (delL * (1.0f - ping) + delR * ping) * feed));
    line_write(&e->r, srcR + echo_color(e, 1, (delR * (1.0f - ping) + delL * ping) * feed));
    *outL = delL * e->level;
    *outR = delR * e->level;
    e->quiet = energy + fabsf(*outL) + fabsf(*outR) < 1e-6f ? e->quiet + 1 : 0;
}

static void ingest_phrase(Engine *engine) {
    char *text = engine->phrase_text;
    engine->phrase_pending = 0;
    if (!text || text[0] == 'S') {
        engine->phrase_on = 0;
        return;
    }
    if (text[0] != 'P') return;
    char *tempo = strchr(text, '|');
    char *reset = tempo ? strchr(tempo + 1, '|') : NULL;
    char *body = reset ? strchr(reset + 1, '|') : NULL;
    if (!body) return;
    engine->tempo = strtof(tempo + 1, NULL);
    if (atoi(reset + 1)) {
        engine->clock = 0;
        space_clear(engine);
    }
    engine->phrase_on = 1;
    engine->phrase_count = 0;
    for (int lane = 0; lane < LANE_COUNT; lane++) {
        engine->lanes[lane].live_count = 0;
        engine->lanes[lane].still_count = 0;
    }
    char *cursor = body + 1;
    char *space = strchr(cursor, '@');
    if (space) {
        *space = 0;
        apply_space(engine, space + 1);
    }
    char *split = strchr(cursor, '#');
    if (split) *split = 0;
    while (cursor && *cursor && engine->phrase_count < PHRASE_CAP) {
        char *semi = strchr(cursor, ';');
        if (semi) *semi = 0;
        PhraseEv *slot = &engine->phrase[engine->phrase_count];
        slot->params[0] = 0;
        if (sscanf(cursor, "%d:%d:%d:%d:%d:%d", &slot->sample, &slot->loop, &slot->lane, &slot->note, &slot->velocity, &slot->ticks) == 6) {
            const char *params = NULL;
            for (int colon = 0, i = 0; cursor[i]; i++) {
                if (cursor[i] == ':' && ++colon == 6) {
                    params = cursor + i + 1;
                    break;
                }
            }
            if (params) snprintf(slot->params, sizeof slot->params, "%s", params);
            if (slot->loop < 1) slot->loop = 1;
            if (slot->sample < 0) slot->sample = 0;
            if (slot->sample >= slot->loop) slot->sample %= slot->loop;
            engine->phrase_count++;
        }
        cursor = semi ? semi + 1 : NULL;
    }
    if (split) {
        char *motion = split + 1;
        while (motion && *motion) {
            char *semi = strchr(motion, ';');
            if (semi) *semi = 0;
            int lane = 0, pattern = 0, loop = 0, pattern_b = 0;
            float value = 0, cycle = 0, amount = 0, value_b = 0, cycle_b = 0, amount_b = 0, morph_t = 0;
            char id[24];
            int fields = sscanf(motion, "%d:%23[^:]:%f:%d:%f:%f:%d:%f:%d:%f:%f:%f",
                &lane, id, &value, &pattern, &cycle, &amount, &loop, &value_b, &pattern_b, &cycle_b, &amount_b, &morph_t);
            if (fields == 12) {
                push_lane(engine, lane, param_of(id), value, pattern, cycle, amount, 1, value_b, pattern_b, cycle_b, amount_b, morph_t);
            } else if (fields == 7) {
                push_lane(engine, lane, param_of(id), value, pattern, cycle, amount, 0, 0, 0, 0, 0, 0);
            }
            motion = semi ? semi + 1 : NULL;
        }
    }
    /* A rebuilt chord grid keeps the running clock. Starts already behind that
     * clock would otherwise stay silent until the next loop — bars late.
     * The same grid sent again (the keepalive) must not re-attack. */
    unsigned sig = phrase_timing_sig(engine);
    int restarted = atoi(reset + 1);
    if (!restarted && engine->clock > 0 && sig != engine->phrase_sig) catch_holding(engine);
    engine->phrase_sig = sig;
    stamp_held(engine);
}

static unsigned phrase_timing_sig(const Engine *engine) {
    unsigned h = 2166136261u;
    for (int e = 0; e < engine->phrase_count; e++) {
        const PhraseEv *hit = &engine->phrase[e];
        if (hit->lane < DRUMS) continue;
        h = (h ^ (unsigned)hit->sample) * 16777619u;
        h = (h ^ (unsigned)hit->loop) * 16777619u;
        h = (h ^ (unsigned)hit->lane) * 16777619u;
        h = (h ^ (unsigned)hit->note) * 16777619u;
    }
    return h;
}

static void catch_holding(Engine *engine) {
    float tempo = engine->tempo > 1.0f ? engine->tempo : 120.0f;
    for (int e = 0; e < engine->phrase_count; e++) {
        PhraseEv *hit = &engine->phrase[e];
        if (hit->lane < DRUMS) continue;
        int loop = hit->loop > 0 ? hit->loop : 1;
        int pos = engine->clock % loop;
        int start = hit->sample % loop;
        int dur = (int)((hit->ticks * SR * 60.0f) / (tempo * 192.0f));
        if (dur < 1) dur = 1;
        int elapsed = pos - start;
        if (elapsed < 0) elapsed += loop;
        if (elapsed <= 0 || elapsed >= dur) continue;
        Note *note = arm_note(engine, hit->note, hit->velocity, hit->ticks, hit->params, hit->lane, loop);
        note->left = dur - elapsed;
    }
}

#define FIRE_CAP 256
#define FOLLOW_STRIDE 8

typedef struct {
    int offset;
    int index;
} Fire;

static int fire_cmp(const void *a, const void *b) {
    const Fire *fa = (const Fire *)a;
    const Fire *fb = (const Fire *)b;
    return fa->offset - fb->offset;
}

static void render(Engine *engine, int16_t *out, int frames) {
    /* Events in this message belong at the start of the block. Sample offsets
     * are applied by triggering before the frame loop only when offset is 0,
     * and during the loop otherwise. consume parses all events up front, so
     * store them and fire by offset. */
    if (engine->phrase_pending) ingest_phrase(engine);
    typedef struct { int offset, lane, note, velocity, ticks; char params[256]; } Ev;
    Ev ev[64];
    int count = 0;
    if (engine->has_block) {
        char text[TEXT_CAP];
        memcpy(text, engine->block, TEXT_CAP);
        engine->has_block = 0;
        char *pipe = strchr(text, '|');
        char *body = text;
        if (pipe) {
            *pipe = 0;
            engine->tempo = strtof(text, NULL);
            body = pipe + 1;
        }
        char *cursor = body;
        while (cursor && *cursor && count < 64) {
            char *semi = strchr(cursor, ';');
            if (semi) *semi = 0;
            Ev *slot = &ev[count];
            slot->params[0] = 0;
            if (sscanf(cursor, "%d:%d:%d:%d:%d", &slot->offset, &slot->lane, &slot->note, &slot->velocity, &slot->ticks) == 5) {
                const char *sixth = NULL;
                for (int colon = 0, i = 0; cursor[i]; i++) {
                    if (cursor[i] == ':' && ++colon == 5) {
                        sixth = cursor + i + 1;
                        break;
                    }
                }
                if (sixth) snprintf(slot->params, sizeof slot->params, "%s", sixth);
                count++;
            }
            cursor = semi ? semi + 1 : NULL;
        }
    }

    /* Schedule phrase hits for this block once — scanning the whole phrase
     * on every sample was the main underrun source with all lanes live. */
    Fire fires[FIRE_CAP];
    int fire_count = 0;
    if (engine->phrase_on && frames > 0) {
        int C = engine->clock;
        for (int e = 0; e < engine->phrase_count; e++) {
            PhraseEv *hit = &engine->phrase[e];
            int loop = hit->loop > 0 ? hit->loop : 1;
            int mod = C % loop;
            int t0 = hit->sample - mod;
            if (t0 < 0) t0 += loop;
            for (int t = t0; t < frames && fire_count < FIRE_CAP; t += loop) {
                fires[fire_count].offset = t;
                fires[fire_count].index = e;
                fire_count++;
            }
        }
        if (fire_count > 1) qsort(fires, (size_t)fire_count, sizeof(Fire), fire_cmp);
    }

    int fi = 0;
    for (int i = 0; i < frames; i++) {
        if (engine->phrase_on) {
            while (fi < fire_count && fires[fi].offset == i) {
                PhraseEv *hit = &engine->phrase[fires[fi].index];
                if (hit->lane >= 0 && hit->lane < DRUMS) arm_drum(engine, hit->lane, hit->note, hit->velocity, hit->params, hit->loop);
                else arm_note(engine, hit->note, hit->velocity, hit->ticks, hit->params, hit->lane, hit->loop);
                fi++;
            }
            engine->clock++;
        }
        for (int e = 0; e < count; e++) {
            if (ev[e].offset != i) continue;
            if (ev[e].lane >= 0 && ev[e].lane < DRUMS) arm_drum(engine, ev[e].lane, ev[e].note, ev[e].velocity, ev[e].params, 0);
            else arm_note(engine, ev[e].note, ev[e].velocity, ev[e].ticks, ev[e].params, ev[e].lane, 0);
        }
        if ((i & (FOLLOW_STRIDE - 1)) == 0) follow_sound(engine);
        float left = 0, right = 0, revL = 0, revR = 0, dlyL = 0, dlyR = 0;
        for (int d = 0; d < DRUMS; d++) {
            if (!engine->drums[d].on) continue;
            float sample = drum_sample(engine, &engine->drums[d]);
            float pan = engine->drums[d].pan;
            if (pan < 0) pan = 0;
            if (pan > 1) pan = 1;
            float l = sample * (1.0f - pan);
            float r = sample * pan;
            left += l;
            right += r;
            revL += l * engine->drums[d].reverb;
            revR += r * engine->drums[d].reverb;
            dlyL += l * engine->drums[d].delay;
            dlyR += r * engine->drums[d].delay;
        }
        for (int n = 0; n < NOTES; n++) {
            if (!engine->notes[n].on) continue;
            float nl = 0, nr = 0;
            note_sample(engine, &engine->notes[n], &nl, &nr);
            left += nl;
            right += nr;
            revL += nl * engine->notes[n].reverb;
            revR += nr * engine->notes[n].reverb;
            dlyL += nl * engine->notes[n].delay;
            dlyR += nr * engine->notes[n].delay;
        }
        float wetL = 0, wetR = 0, delL = 0, delR = 0;
        plate_sample(engine, revL, revR, &wetL, &wetR);
        echo_sample(engine, dlyL, dlyR, &delL, &delR);
        float l = soft(left + wetL + delL);
        float r = soft(right + wetR + delR);
        if (out) {
            int il = (int)(l * 32767.0f);
            int ir = (int)(r * 32767.0f);
            if (il > 32767) il = 32767;
            if (il < -32767) il = -32767;
            if (ir > 32767) ir = 32767;
            if (ir < -32767) ir = -32767;
            out[i * 2] = (int16_t)il;
            out[i * 2 + 1] = (int16_t)ir;
        }
    }
}

static void *create_instance(const char *module_dir, const char *json_defaults) {
    (void)module_dir;
    (void)json_defaults;
    Engine *engine = calloc(1, sizeof(Engine));
    if (!engine) return NULL;
    engine->phrase_text = calloc(1, PHRASE_TEXT);
    if (!engine->phrase_text) {
        free(engine);
        return NULL;
    }
    engine->noise = 1;
    engine->tempo = 120.0f;
    engine->beats = 4.0f;
    ensure_wave_table();
    if (!space_init(engine)) {
        space_free(engine);
        free(engine->phrase_text);
        free(engine);
        return NULL;
    }
    return engine;
}

static void set_param(void *instance, const char *key, const char *val) {
    Engine *engine = instance;
    if (!key || !val) return;
    if (strcmp(key, "block") != 0 && strcmp(key, "overtake_dsp:block") != 0) return;
    if (val[0] == 'P' || val[0] == 'S') {
        snprintf(engine->phrase_text, PHRASE_TEXT, "%s", val);
        engine->phrase_pending = 1;
        return;
    }
    snprintf(engine->block, TEXT_CAP, "%s", val);
    engine->has_block = 1;
}

#ifndef PTNMOVE_TEST
static void destroy_instance(void *instance) {
    Engine *engine = instance;
    if (!engine) return;
    space_free(engine);
    free(engine->phrase_text);
    free(engine);
}

static void on_midi(void *instance, const uint8_t *msg, int len, int source) {
    (void)instance;
    (void)msg;
    (void)len;
    (void)source;
}

static int get_param(void *instance, const char *key, char *buf, int buf_len) {
    (void)instance;
    (void)key;
    (void)buf;
    (void)buf_len;
    return -1;
}

static int get_error(void *instance, char *buf, int buf_len) {
    (void)instance;
    if (buf && buf_len > 0) buf[0] = 0;
    return 0;
}

static void render_block(void *instance, int16_t *out, int frames) {
    render(instance, out, frames);
}

static plugin_api_v2_t API = {
    2,
    create_instance,
    destroy_instance,
    on_midi,
    set_param,
    get_param,
    get_error,
    render_block,
};

plugin_api_v2_t *move_plugin_init_v2(void *host) {
    (void)host;
    return &API;
}
#endif

#ifdef PTNMOVE_TEST
static int fail(const char *message) {
    fprintf(stderr, "%s\n", message);
    return 1;
}

int main(void) {
    Engine *engine = create_instance(NULL, NULL);
    int16_t out[256];
    long left = 0, right = 0;
    set_param(engine, "block", "120|0:2:42:100:48:v07_pan=0.0000,v07_dcy=0.4000,v07_mix=0.8000");
    render(engine, out, 128);
    for (int i = 0; i < 128; i++) {
        left += out[i * 2] < 0 ? -out[i * 2] : out[i * 2];
        right += out[i * 2 + 1] < 0 ? -out[i * 2 + 1] : out[i * 2 + 1];
    }
    if (left < right * 2) return fail("pan left did not reach the left channel");

    engine = create_instance(NULL, NULL);
    set_param(engine, "block", "120|0:4:40:100:192:wave=0.4200,wide=0.0000,cutoff=0.8000,attack=0.0000,release=0.8000");
    render(engine, out, 128);
    long diff_narrow = 0, level = 0;
    for (int i = 0; i < 128; i++) {
        int d = out[i * 2] - out[i * 2 + 1];
        diff_narrow += d < 0 ? -d : d;
        level += out[i * 2] < 0 ? -out[i * 2] : out[i * 2];
    }
    if (level < 20) return fail("melodic voice stayed silent");

    engine = create_instance(NULL, NULL);
    set_param(engine, "block", "120|0:6:64:110:192:wave=0.4200,wide=1.0000,cutoff=0.9000,attack=0.0000,release=0.8000");
    render(engine, out, 128);
    long diff_wide = 0;
    for (int i = 0; i < 128; i++) {
        int d = out[i * 2] - out[i * 2 + 1];
        diff_wide += d < 0 ? -d : d;
    }
    if (diff_wide <= diff_narrow) return fail("wide did not open the stereo image");

    engine = create_instance(NULL, NULL);
    set_param(engine, "block", "P|120|1|0:300:0:36:120:48:v01_dcy=0.0500");
    render(engine, out, 128);
    int age_first = engine->drums[0].age;
    render(engine, out, 128);
    int age_mid = engine->drums[0].age;
    render(engine, out, 128);
    if (!(age_mid > age_first && engine->drums[0].age < age_mid)) return fail("phrase did not loop on the audio clock");

    engine = create_instance(NULL, NULL);
    set_param(engine, "block", "120|0:0:36:120:48:v01_freq=0.4000,v01_dcy=0.7000,v01_dist=0.5000");
    render(engine, out, 128);
    int peak = 0;
    for (int i = 0; i < 256; i++) {
        int a = out[i] < 0 ? -out[i] : out[i];
        if (a > peak) peak = a;
    }
    if (peak < 100) return fail("kick peak is too small");

    engine = create_instance(NULL, NULL);
    set_param(engine, "block", "P|120|1|0:44104:4:40:100:768:cutoff=0.0000,release=0.8000#4:cutoff:0.0000:0:8:1.0000:44104");
    for (int n = 0; n < 86; n++) render(engine, out, 128);
    if (engine->notes[0].cutoff < 0.9f) return fail("cutoff did not follow the generator");

    engine = create_instance(NULL, NULL);
    set_param(engine, "block", "P|120|1|0:44104:0:36:120:48:v01_freq=0.2000,v01_dcy=0.7000#0:v01_freq:0.2000:0:8:1.0000:44104");
    render(engine, out, 128);
    float held_freq = engine->drums[0].freq;
    for (int n = 0; n < 86; n++) render(engine, out, 128);
    if (engine->drums[0].freq != held_freq) return fail("pitch followed the generator");

    printf("ok peak=%d panL=%ld width=%ld\n", peak, left, diff_wide);
    return 0;
}
#endif
