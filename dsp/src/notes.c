#include "engine.h"

float bend_unit(float u, float bend) {
    if (bend <= 1e-4f || u <= 0.0f) return u;
    return powf(u, 1.0f + bend * bend * 3.0f);
}

/* Same integer mix as unisonPhase in src/dsp/voice.ts. */

float unison_phase(int pitch, int lane, int sample, int copy) {
    uint32_t h = (uint32_t)pitch * 0x16566731u
        + (uint32_t)lane * 0x27d4eb2fu
        + (uint32_t)sample * 0x85ebca77u
        + (uint32_t)copy * 0xc2b2ae35u;
    h ^= h >> 16;
    h *= 0x7feb352du;
    h ^= h >> 15;
    h *= 0x846ca68bu;
    h ^= h >> 16;
    return ((float)h / 4294967296.0f) * TWO_PI;
}

float unison_weight(float wide, int index) {
    if (wide <= 1e-4f || index == 1) return 1.0f;
    return wide * wide;
}

float unison_cents(float wide, int index) {
    if (wide <= 1e-4f || index == 1) return 0.0f;
    return (index == 0 ? -wide : wide) * UNI_CENTS;
}

float unison_pan(float wide, int index) {
    if (wide <= 1e-4f || index == 1) return 0.0f;
    return (index == 0 ? -UNI_PAN : UNI_PAN);
}

float advance_osc(Note *note, int index, float inc, float sync, float bend, float wave) {
    float *phase = &note->phase[index];
    float *slave = &note->slave[index];
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
    wave_fix(&note->osc[index], read_freq, wave);
    return wave_read(&note->osc[index], bend_unit(u, bend));
}

void apply_note(Note *note, int param, float unit) {
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
    case P_RELEASE: note->release = unit; break;
    case P_WIDE: note->wide = unit; break;
    case P_GLIDE: note->glide = unit; break;
    case P_SUSTAIN: note->sustain = unit; break;
    case P_ENV: note->env_amt = unit; break;
    default: break;
    }
}

void stamp_note(Engine *engine, Note *note) {
    if (note->lane < DRUMS || note->lane >= LANE_COUNT) return;
    LaneBox *box = &engine->lanes[note->lane];
    for (int m = 0; m < box->still_count; m++) apply_note(note, box->still[m].param, clampf01(box->still[m].value));
}

void stamp_held(Engine *engine) {
    for (int n = 0; n < NOTES; n++) {
        if (engine->notes[n].on) stamp_note(engine, &engine->notes[n]);
    }
}

/* A block arms every tone before any of them renders, so each new one still
 * has age 0 and a silent envelope. Stealing the quietest voice would take the
 * tone just armed and leave a single voice once releases fill the pool. */

float note_amp(const Note *note) {
    return note->env;
}

Note *steal(Engine *engine) {
    Note *quiet_release = NULL;
    Note *oldest_held = NULL;
    for (int i = 0; i < NOTES; i++) {
        Note *note = &engine->notes[i];
        if (!note->on) return note;
        if (note->age == 0) continue;
        if (note->left <= 0) {
            if (!quiet_release || note_amp(note) < note_amp(quiet_release)) quiet_release = note;
        } else if (!oldest_held || note->age > oldest_held->age) {
            oldest_held = note;
        }
    }
    if (quiet_release) return quiet_release;
    if (oldest_held) return oldest_held;
    return &engine->notes[0];
}

float midi_freq(int pitch) {
    return 440.0f * powf(2.0f, ((float)pitch - 69.0f) / 12.0f);
}

int begin_arm(Engine *engine) {
    if (engine->arm_clock != engine->clock) {
        engine->arm_clock = engine->clock;
        engine->arm_serial += 1;
    }
    return engine->arm_serial;
}

/* Nearest sounding voice of this lane. Other lanes stay put. */

Note *glide_voice(Engine *engine, int lane, int pitch, int serial) {
    Note *best = NULL;
    int best_dist = 1000;
    for (int i = 0; i < NOTES; i++) {
        Note *note = &engine->notes[i];
        int dist;
        if (!note->on || note->age == 0 || note->lane != lane || note->claim == serial) continue;
        dist = note->pitch - pitch;
        if (dist < 0) dist = -dist;
        if (dist < best_dist) {
            best = note;
            best_dist = dist;
        }
    }
    return best;
}

void paint_note(Note *note, int note_num, int velocity, int samples, const char *params, int lane, int loop) {
    note->lane = lane;
    note->pitch = note_num;
    note->loop = loop;
    note->left = samples;
    note->gate = samples;
    note->target = midi_freq(note_num);
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
    note->glide = read_param(params, "glide", 0.0f);
    note->sustain = melody_sustain_of(params);
    note->env_amt = read_param(params, "env", 0.0f);
    note->gain = velocity / 127.0f;
}

static void attack_fields(Note *note) {
    note->on = 1;
    note->env = 0;
    note->age = 0;
    note->filter_env = 0.0f;
    note->legato = 0;
    note->from_amp = 0.0f;
    note->from_contour = 0.0f;
}

/* Hard note-on. Phase, filter and the Haas buffer start clean. */
static void hard_attack(Engine *engine, Note *note, int note_num, int lane, float glide) {
    int copy;
    float target = midi_freq(note_num);
    float remembered = lane >= 0 && lane < LANE_COUNT ? engine->lane_freq[lane] : 0.0f;
    for (copy = 0; copy < 3; copy++) {
        note->phase[copy] = unison_phase(note_num, lane, engine->clock, copy);
        note->slave[copy] = 0.0f;
    }
    note->haas_i = 0;
    memset(note->haas, 0, sizeof note->haas);
    note->low = 0;
    note->band = 0;
    note->freq = glide > 1e-4f && remembered > 1.0f ? remembered : target;
}

Note *arm_note(Engine *engine, int note_num, int velocity, int ticks, const char *params, int lane, int loop) {
    float tempo = engine->tempo > 1.0f ? engine->tempo : 120.0f;
    int samples = (int)((ticks * SR * 60.0f) / (tempo * 192.0f));
    int serial = begin_arm(engine);
    float glide = read_param(params, "glide", 0.0f);
    Note *prior = glide > 1e-4f ? glide_voice(engine, lane, note_num, serial) : NULL;
    int legato = prior && prior->left > 0;
    Note *note = prior ? prior : steal(engine);
    if (samples < 1) samples = 1;
    note->on = 1;
    if (!legato) {
        attack_fields(note);
        if (!prior) hard_attack(engine, note, note_num, lane, glide);
    }
    paint_note(note, note_num, velocity, samples, params, lane, loop);
    if (legato) {
        note->legato = 1;
        note->from_amp = prior->env;
        note->from_contour = prior->filter_env;
        note->age = 0;
    }
    if (glide <= 1e-4f) note->freq = note->target;
    note->claim = serial;
    stamp_note(engine, note);
    arm_sample_note(engine, note, params, note_num, legato);
    return note;
}

/* A grid rebuild starts a pitch that is not already sounding. The caller picks
 * the voice, so a held note on another lane is never reset. */
Note *arm_fresh(Engine *engine, Note *note, int note_num, int velocity, int ticks, const char *params, int lane, int loop) {
    float tempo = engine->tempo > 1.0f ? engine->tempo : 120.0f;
    int samples = (int)((ticks * SR * 60.0f) / (tempo * 192.0f));
    int serial;
    if (!note) return NULL;
    if (samples < 1) samples = 1;
    serial = begin_arm(engine);
    attack_fields(note);
    hard_attack(engine, note, note_num, lane, 0.0f);
    paint_note(note, note_num, velocity, samples, params, lane, loop);
    note->freq = note->target;
    note->claim = serial;
    stamp_note(engine, note);
    arm_sample_note(engine, note, params, note_num, 0);
    return note;
}

float shape_note(float sample, float fold, float drive) {
    float mix = sample;
    if (fold > 1e-4f) {
        float folded = sinf(mix * (1.0f + fold * fold * 4.0f));
        mix += (folded - mix) * fold;
    }
    if (drive > 1e-4f) {
        float amount = drive * drive * 5.0f;
        float driven = mix * (1.0f + amount);
        mix = driven / (1.0f + amount * fabsf(mix));
    }
    return mix;
}

static void slew_sample(Note *note) {
    float tau = glide_seconds(note->glide);
    float k, log_f, log_t;
    if (!(tau > 0.0f) || !(note->sample_rate > 0.0f)) {
        note->sample_rate = note->sample_target;
        return;
    }
    k = 1.0f - expf(-1.0f / (tau * SR));
    log_f = logf(note->sample_rate);
    log_t = logf(note->sample_target > 1e-6f ? note->sample_target : 1e-6f);
    note->sample_rate = expf(log_f + (log_t - log_f) * k);
}

static float sample_inc(const SampleBank *bank, const Note *note, float ratio) {
    float sr;
    if (!bank_is_ready(bank) || note->sample_zone < 0 || note->sample_zone >= bank->zone_count) return 0;
    sr = bank->zones[note->sample_zone].sample_rate;
    if (!(sr > 1.0f)) sr = SR;
    return ratio * sr / SR;
}

void slew_note(Note *note) {
    float tau = glide_seconds(note->glide);
    float k, log_f, log_t;
    if (!(tau > 0.0f) || !(note->freq > 0.0f)) {
        note->freq = note->target;
        return;
    }
    k = 1.0f - expf(-1.0f / (tau * SR));
    log_f = logf(note->freq);
    log_t = logf(note->target > 1e-6f ? note->target : 1e-6f);
    note->freq = expf(log_f + (log_t - log_f) * k);
}

void note_sample(Engine *engine, Note *note, float *left, float *right) {
    float inc;
    int open;
    float norm, mid = 0.0f, side = 0.0f, resonated, level, gain, sided;
    int quiet;
    slew_note(note);
    inc = (TWO_PI * note->freq) / SR;
    open = note->wide > 1e-4f;
    if (note->sample_on && bank_is_ready(&engine->samples)) {
        float base;
        slew_sample(note);
        base = sample_inc(&engine->samples, note, note->sample_rate);
        if (!open) {
            mid = shape_note(sample_take(&engine->samples, note->sample_zone, &note->sample_pos[1], base), 0.0f, note->drive);
        } else {
            float w, cents, shaped, scaled;
            if (note->wide_key != note->wide) {
                w = note->wide * note->wide;
                cents = note->wide * UNI_CENTS;
                note->side_w = w;
                note->uni_norm = 1.0f / sqrtf(1.0f + 2.0f * w * w);
                note->ratio_lo = powf(2.0f, -cents / 1200.0f);
                note->ratio_hi = powf(2.0f, cents / 1200.0f);
                note->wide_key = note->wide;
            }
            w = note->side_w;
            norm = note->uni_norm;
            shaped = shape_note(sample_take(&engine->samples, note->sample_zone, &note->sample_pos[1], base), 0.0f, note->drive);
            mid = shaped;
            shaped = shape_note(sample_take(&engine->samples, note->sample_zone, &note->sample_pos[0], base * note->ratio_lo), 0.0f, note->drive);
            scaled = shaped * w;
            mid += scaled;
            side += scaled * (-UNI_PAN);
            shaped = shape_note(sample_take(&engine->samples, note->sample_zone, &note->sample_pos[2], base * note->ratio_hi), 0.0f, note->drive);
            scaled = shaped * w;
            mid += scaled;
            side += scaled * UNI_PAN;
            mid *= norm;
            side *= norm;
        }
        if (note->lane >= 0 && note->lane < LANE_COUNT) engine->lane_sample_rate[note->lane] = note->sample_rate;
    } else if (!open) {
        /* Center voice only. Weight is 1, so the unison norm and the detune pow drop out. */
        mid = shape_note(advance_osc(note, 1, inc, note->sync, note->bend, note->wave), note->fold, note->drive);
    } else {
        /* Three readers. The detune ratio and the mip stay put until wide, wave or frequency moves. */
        float w, cents, shaped, scaled;
        if (note->wide_key != note->wide) {
            w = note->wide * note->wide;
            cents = note->wide * UNI_CENTS;
            note->side_w = w;
            note->uni_norm = 1.0f / sqrtf(1.0f + 2.0f * w * w);
            note->ratio_lo = powf(2.0f, -cents / 1200.0f);
            note->ratio_hi = powf(2.0f, cents / 1200.0f);
            note->wide_key = note->wide;
        }
        w = note->side_w;
        norm = note->uni_norm;
        shaped = shape_note(advance_osc(note, 1, inc, note->sync, note->bend, note->wave), note->fold, note->drive);
        mid = shaped;
        shaped = shape_note(advance_osc(note, 0, inc * note->ratio_lo, note->sync, note->bend, note->wave), note->fold, note->drive);
        scaled = shaped * w;
        mid += scaled;
        side += scaled * (-UNI_PAN);
        shaped = shape_note(advance_osc(note, 2, inc * note->ratio_hi, note->sync, note->bend, note->wave), note->fold, note->drive);
        scaled = shaped * w;
        mid += scaled;
        side += scaled * UNI_PAN;
        mid *= norm;
        side *= norm;
    }
    note->filter_env = melody_contour((float)note->age, (float)note->gate, note->attack, note->legato, note->from_contour);
    resonated = filter_sample(&note->low, &note->band, &note->coef, mid, melody_cutoff(note->cutoff, note->env_amt, note->filter_env), note->resonance);
    level = melody_level((float)note->age, (float)note->gate, note->attack, note->sustain, melody_release_seconds(note->release), note->legato, note->from_amp);
    note->env = level;
    note->age += 1;
    if (note->left > 0) note->left -= 1;
    quiet = note->left <= 0 && level < 0.0008f;
    if (note->left <= 0 && quiet) note->on = 0;
    if (note->freq > 1.0f && note->lane >= 0 && note->lane < LANE_COUNT) engine->lane_freq[note->lane] = note->freq;
    gain = resonated * level * note->gain * NOTE_LEVEL;
    sided = side * level * note->gain * NOTE_LEVEL;
    *left += gain + sided;
    *right += gain - sided;
}
