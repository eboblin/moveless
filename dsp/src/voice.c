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
#define MOTION_CAP 80

typedef struct {
    int on;
    int lane;
    float phase, phase2, env, noise_env, freq, decay, noise_decay;
    float noise, drive, tone, pan, spread, snap, bright, bend, body, low, base;
    int age, loop;
} Drum;

typedef struct {
    int on;
    float phase, phase2, env, freq, shape, detune, fm, noise, cutoff, resonance, attack, release, width, gain, low, band;
    int age, left, lane, loop;
} Note;

typedef struct {
    int lane;
    int loop;
    int pattern;
    float value, cycle, amount;
    char id[24];
} Motion;

typedef struct {
    int sample;
    int loop;
    int lane;
    int note;
    int velocity;
    int ticks;
    char params[192];
} PhraseEv;

typedef struct {
    uint32_t noise;
    float tempo;
    char block[TEXT_CAP];
    int has_block;
    char *phrase_text;
    int phrase_pending;
    int phrase_on;
    int phrase_count;
    int clock;
    int motion_count;
    Motion motions[MOTION_CAP];
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

static float wave(float phase, float shape) {
    float wrapped = fmodf(phase, TWO_PI);
    if (wrapped < 0) wrapped += TWO_PI;
    float sine = sinf(wrapped);
    float saw = wrapped / 3.14159265f - 1.0f;
    float square = wrapped < 3.14159265f ? 1.0f : -1.0f;
    if (shape < 0.5f) {
        float t = shape * 2.0f;
        return sine * (1.0f - t) + saw * t;
    }
    float t = (shape - 0.5f) * 2.0f;
    return saw * (1.0f - t) + square * t;
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

static float eval_motion(const Motion *motion, float step) {
    int cycle = (int)roundf(motion->cycle);
    if (cycle < 1) cycle = 1;
    float wrapped = fmodf(step, (float)cycle);
    if (wrapped < 0) wrapped += (float)cycle;
    if (motion->amount == 0.0f) return clampf01(motion->value);
    return clampf01(motion->value + motif_at(motion->pattern, wrapped / (float)cycle) * motion->amount);
}

static void follow_sound(Engine *engine) {
    if (!engine->motion_count || engine->clock < 1) return;
    float tempo = engine->tempo > 1.0f ? engine->tempo : 120.0f;
    float span = roundf((48.0f * SR * 60.0f) / (tempo * 192.0f));
    if (span < 1.0f) span = 1.0f;
    int pos = engine->clock - 1;
    for (int d = 0; d < DRUMS; d++) {
        Drum *drum = &engine->drums[d];
        if (!drum->on || drum->loop < 1) continue;
        float step = (float)(pos % drum->loop) / span;
        for (int m = 0; m < engine->motion_count; m++) {
            Motion *motion = &engine->motions[m];
            if (motion->lane != d) continue;
            float unit = eval_motion(motion, step);
            if (suffix_is(motion->id, "freq")) continue;
            else if (suffix_is(motion->id, "dcy")) drum->decay = 0.04f + unit * 0.9f;
            else if (suffix_is(motion->id, "nedcy")) drum->noise_decay = 0.02f + unit * 0.85f;
            else if (suffix_is(motion->id, "mix")) drum->noise = unit;
            else if (suffix_is(motion->id, "dist")) drum->drive = unit;
            else if (suffix_is(motion->id, "nfq")) drum->tone = unit;
            else if (suffix_is(motion->id, "pan")) drum->pan = unit;
            else if (suffix_is(motion->id, "mrate")) drum->spread = unit;
            else if (suffix_is(motion->id, "nffrq")) drum->bright = unit;
            else if (suffix_is(motion->id, "atk")) drum->snap = unit;
            else if (suffix_is(motion->id, "mamt")) drum->bend = unit;
            else if (suffix_is(motion->id, "lvl")) drum->body = unit;
        }
    }
    for (int n = 0; n < NOTES; n++) {
        Note *note = &engine->notes[n];
        if (!note->on || note->loop < 1) continue;
        float step = (float)(pos % note->loop) / span;
        for (int m = 0; m < engine->motion_count; m++) {
            Motion *motion = &engine->motions[m];
            if (motion->lane != note->lane) continue;
            float unit = eval_motion(motion, step);
            if (strcmp(motion->id, "osc_shape") == 0) note->shape = unit;
            else if (strcmp(motion->id, "osc_detune") == 0) note->detune = unit;
            else if (strcmp(motion->id, "osc_fm") == 0) note->fm = unit;
            else if (strcmp(motion->id, "noise") == 0) note->noise = unit;
            else if (strcmp(motion->id, "cutoff") == 0) note->cutoff = unit;
            else if (strcmp(motion->id, "resonance") == 0) note->resonance = unit;
            else if (strcmp(motion->id, "attack") == 0) note->attack = unit;
            else if (strcmp(motion->id, "release") == 0 || strcmp(motion->id, "decay") == 0) note->release = unit;
            else if (strcmp(motion->id, "osc_width") == 0) note->width = unit;
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
    drum->decay = 0.04f + read_param(params, "dcy", 0.5f) * 0.9f;
    drum->noise_decay = 0.02f + read_param(params, "nedcy", hat ? 0.35f : 0.45f) * 0.85f;
    drum->noise = read_param(params, "mix", hat ? 0.85f : (idx == 1 ? 0.55f : 0.15f));
    drum->drive = read_param(params, "dist", 0.15f);
    drum->tone = read_param(params, "nfq", hat ? 0.75f : 0.45f);
    drum->pan = read_param(params, "pan", 0.5f);
    drum->spread = read_param(params, "mrate", hat ? 0.4f : 0.1f);
    drum->snap = read_param(params, "atk", idx == 0 ? 0.35f : (hat ? 0.25f : 0.45f));
    drum->bright = read_param(params, "nffrq", hat ? 0.7f : 0.4f);
    drum->bend = read_param(params, "mamt", idx == 0 ? 0.55f : (idx == 3 ? 0.35f : 0.1f));
    drum->body = read_param(params, "lvl", hat ? 0.12f : 1.0f);
    drum->low = 0;
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

static void arm_note(Engine *engine, int note_num, int velocity, int ticks, const char *params, int lane, int loop) {
    Note *note = steal(engine);
    float tempo = engine->tempo > 1.0f ? engine->tempo : 120.0f;
    int samples = (int)((ticks * SR * 60.0f) / (tempo * 192.0f));
    if (samples < 1) samples = 1;
    note->on = 1;
    note->phase = 0;
    note->phase2 = 0;
    note->env = 0;
    note->age = 0;
    note->left = samples;
    note->lane = lane;
    note->loop = loop;
    note->freq = 440.0f * powf(2.0f, ((float)note_num - 69.0f) / 12.0f);
    note->shape = read_param(params, "osc_shape", 0.5f);
    note->detune = read_param(params, "osc_detune", 0.5f);
    note->fm = read_param(params, "osc_fm", 0.0f);
    note->noise = read_param(params, "noise", 0.0f);
    note->cutoff = read_param(params, "cutoff", 0.7f);
    note->resonance = read_param(params, "resonance", 0.0f);
    note->attack = read_param(params, "attack", 0.0f);
    note->release = read_param(params, "release", read_param(params, "decay", 0.4f));
    note->width = read_param(params, "osc_width", 0.0f);
    note->gain = velocity / 127.0f;
    note->low = 0;
    note->band = 0;
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
    float click_tau = 10.0f + drum->snap * 160.0f + (1.0f - drum->bright) * 260.0f;
    float click = rng(engine) * expf(-(float)drum->age / click_tau) * drum->snap * (0.35f + drum->bright * 1.4f);
    float noisy = rng(engine) * drum->noise * (hat ? 0.45f + drum->bright * 0.7f : 1.0f);
    float mixed = body * drum->env + noisy * drum->noise_env + click;
    float coef = 0.025f + drum->tone * drum->tone * 0.95f;
    drum->low += (mixed - drum->low) * coef;
    float gain = 1.0f + drum->drive * 8.0f;
    float driven = drum->low * gain;
    driven = driven / (1.0f + fabsf(driven));
    float dcy = drum->decay < 0.015f ? 0.015f : drum->decay;
    float ndcy = drum->noise_decay < 0.012f ? 0.012f : drum->noise_decay;
    drum->env *= expf(-1.0f / (dcy * SR));
    drum->noise_env *= expf(-1.0f / (ndcy * SR));
    drum->age += 1;
    if (drum->env < 0.0008f && drum->noise_env < 0.0008f && (float)drum->age > click_tau * 4.0f) drum->on = 0;
    return driven;
}

static void note_sample(Engine *engine, Note *note, float *left, float *right) {
    float inc = (TWO_PI * note->freq) / SR;
    note->phase += inc + sinf(note->phase) * note->fm * inc * 8.0f;
    float ratio = 1.0f + (note->detune - 0.5f) * 0.35f;
    note->phase2 += inc * ratio;
    float primary = wave(note->phase, note->shape);
    float second = wave(note->phase2, note->shape);
    float det = fabsf(note->detune - 0.5f) * 2.0f;
    float noisy = primary + second * 0.35f * det + rng(engine) * note->noise * 0.85f;
    float coef = 0.015f + note->cutoff * note->cutoff * 0.92f;
    note->low += (noisy - note->low) * coef;
    float diff = noisy - note->low;
    note->band += (diff - note->band) * (0.08f + note->resonance * 0.45f);
    float resonated = note->low + note->band * note->resonance * 5.0f;
    float attack_samples = 1.0f + note->attack * 0.2f * SR;
    if ((float)note->age < attack_samples) note->env = ((float)note->age + 1.0f) / attack_samples;
    else note->env *= expf(-1.0f / ((0.04f + note->release * 1.6f) * SR));
    note->age += 1;
    note->left -= 1;
    if (note->left <= 0 || note->env < 0.0008f) note->on = 0;
    float gain = resonated * note->env * note->gain * 0.38f;
    float wide = second * note->width * gain * 1.35f;
    *left += gain + wide;
    *right += gain - wide;
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
    if (atoi(reset + 1)) engine->clock = 0;
    engine->phrase_on = 1;
    engine->phrase_count = 0;
    engine->motion_count = 0;
    char *cursor = body + 1;
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
    if (!split) return;
    char *motion = split + 1;
    while (motion && *motion && engine->motion_count < MOTION_CAP) {
        char *semi = strchr(motion, ';');
        if (semi) *semi = 0;
        Motion *slot = &engine->motions[engine->motion_count];
        if (sscanf(motion, "%d:%23[^:]:%f:%d:%f:%f:%d", &slot->lane, slot->id, &slot->value, &slot->pattern, &slot->cycle, &slot->amount, &slot->loop) == 7) {
            engine->motion_count++;
        }
        motion = semi ? semi + 1 : NULL;
    }
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
    for (int i = 0; i < frames; i++) {
        if (engine->phrase_on) {
            for (int e = 0; e < engine->phrase_count; e++) {
                PhraseEv *hit = &engine->phrase[e];
                if (engine->clock % hit->loop != hit->sample) continue;
                if (hit->lane >= 0 && hit->lane < DRUMS) arm_drum(engine, hit->lane, hit->note, hit->velocity, hit->params, hit->loop);
                else arm_note(engine, hit->note, hit->velocity, hit->ticks, hit->params, hit->lane, hit->loop);
            }
            engine->clock++;
        }
        for (int e = 0; e < count; e++) {
            if (ev[e].offset != i) continue;
            if (ev[e].lane >= 0 && ev[e].lane < DRUMS) arm_drum(engine, ev[e].lane, ev[e].note, ev[e].velocity, ev[e].params, 0);
            else arm_note(engine, ev[e].note, ev[e].velocity, ev[e].ticks, ev[e].params, ev[e].lane, 0);
        }
        follow_sound(engine);
        float left = 0, right = 0;
        for (int d = 0; d < DRUMS; d++) {
            if (!engine->drums[d].on) continue;
            float sample = drum_sample(engine, &engine->drums[d]);
            float angle = engine->drums[d].pan * 1.5707963f;
            left += sample * cosf(angle);
            right += sample * sinf(angle);
        }
        for (int n = 0; n < NOTES; n++) {
            if (!engine->notes[n].on) continue;
            note_sample(engine, &engine->notes[n], &left, &right);
        }
        float l = soft(left);
        float r = soft(right);
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
    set_param(engine, "block", "120|0:4:40:100:192:osc_shape=0.2000,osc_width=0.0000,cutoff=0.8000,attack=0.0000,release=0.8000");
    render(engine, out, 128);
    long diff_narrow = 0, level = 0;
    for (int i = 0; i < 128; i++) {
        int d = out[i * 2] - out[i * 2 + 1];
        diff_narrow += d < 0 ? -d : d;
        level += out[i * 2] < 0 ? -out[i * 2] : out[i * 2];
    }
    if (level < 20) return fail("melodic voice stayed silent");

    engine = create_instance(NULL, NULL);
    set_param(engine, "block", "120|0:6:64:110:192:osc_shape=0.8000,osc_width=1.0000,cutoff=0.9000,attack=0.0000,release=0.8000");
    render(engine, out, 128);
    long diff_wide = 0;
    for (int i = 0; i < 128; i++) {
        int d = out[i * 2] - out[i * 2 + 1];
        diff_wide += d < 0 ? -d : d;
    }
    if (diff_wide <= diff_narrow) return fail("osc_width did not open the stereo image");

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
