#include "engine.h"

float rng(Engine *engine) {
    engine->noise = engine->noise * 1664525u + 1013904223u;
    return (float)engine->noise / 4294967296.0f * 2.0f - 1.0f;
}

float read_param(const char *params, const char *suffix, float fallback) {
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

float soft(float sample) {
    float scaled = sample * 0.35f;
    return scaled / (1.0f + fabsf(scaled));
}

float wrap01(float phase) {
    float wrapped = phase - floorf(phase);
    if (wrapped < 0) wrapped += 1.0f;
    return wrapped;
}

float clampf01(float value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

/* Kick 32–180 Hz, snare 140–900, hat 250–4000, perc 70–2500. The knob is the pitch. */

float drum_pitch_hz(int lane, float unit) {
    float u = clampf01(unit);
    if (lane == 1) return 140.0f * powf(900.0f / 140.0f, u);
    if (lane == 2) return 250.0f * powf(4000.0f / 250.0f, u);
    if (lane == 3) return 70.0f * powf(2500.0f / 70.0f, u);
    return 32.0f * powf(180.0f / 32.0f, u);
}

float squared_seconds(float unit, float lo, float span) {
    float u = clampf01(unit);
    return lo + u * u * span;
}

float kick_decay_seconds(float unit) { return squared_seconds(unit, 0.03f, 1.37f); }

float bend_time_seconds(float unit) { return squared_seconds(unit, 0.008f, 0.392f); }

float snare_body_decay_seconds(float unit) { return squared_seconds(unit, 0.04f, 0.76f); }

float snare_noise_decay_seconds(float unit) { return squared_seconds(unit, 0.02f, 0.58f); }

float hat_decay_seconds(float unit) { return squared_seconds(unit, 0.02f, 1.0f); }

float perc_decay_seconds(float unit) { return squared_seconds(unit, 0.03f, 1.2f); }

void snare_pitch_bend(float body, float *bend, float *bend_time) {
    float distance = body - 0.28f;
    if (distance < 0) distance = -distance;
    *bend_time = 0.02f;
    if (distance >= 0.1f) {
        *bend = 0;
        return;
    }
    *bend = 0.4f * (1.0f - distance / 0.1f);
}

float pole_coef(float hz) {
    return 1.0f - expf((-TWO_PI * hz) / SR);
}

static const float FM_STOPS[7] = {1.0f, 1.5f, 2.0f, 3.0f, 4.0f, 5.0f, 7.0f};
static const float FM_CENTER[7] = {0.06f, 0.21f, 0.36f, 0.51f, 0.66f, 0.81f, 0.96f};

float fm_ratio_of(float unit) {
    float u = clampf01(unit);
    int i;
    for (i = 0; i < 7; i++) {
        float d = u - FM_CENTER[i];
        if (d < 0) d = -d;
        if (d <= 0.055f) return FM_STOPS[i];
    }
    if (u <= FM_CENTER[0]) return FM_STOPS[0];
    for (i = 0; i < 6; i++) {
        float left = FM_CENTER[i] + 0.055f;
        float right = FM_CENTER[i + 1] - 0.055f;
        if (u <= FM_CENTER[i + 1]) {
            float f, s;
            if (u <= left) return FM_STOPS[i];
            if (u >= right) return FM_STOPS[i + 1];
            f = (u - left) / (right - left);
            s = f * f * (3.0f - 2.0f * f);
            return FM_STOPS[i] * (1.0f - s) + FM_STOPS[i + 1] * s;
        }
    }
    return FM_STOPS[6];
}

float glide_seconds(float unit) {
    float t;
    if (unit <= 1e-4f) return 0.0f;
    t = (unit - 0.01f) / 0.99f;
    if (t < 0.0f) t = 0.0f;
    if (t > 1.0f) t = 1.0f;
    return 0.06f * powf(0.5f / 0.06f, t);
}

/* ENV 0 leaves the cutoff knob. Above that the attack opens toward 0.5. */

float melody_cutoff(float cutoff, float env, float contour) {
    float rest;
    if (env <= 1e-4f) return cutoff;
    rest = cutoff > 0.5f ? cutoff : 0.5f + env * 0.45f;
    return rest + (0.5f - rest) * env * contour;
}

float melody_release_seconds(float unit) {
    return 0.04f + clampf01(unit) * 1.6f;
}

float melody_attack_samples(float gate, float attack) {
    float span = gate < 1.0f ? 1.0f : gate;
    float rise = 0.002f * SR;
    float scaled = clampf01(attack) * span;
    if (scaled > rise) rise = scaled;
    return rise > span ? span : rise;
}

/* 1 at u = 0, 0 at u = 1. The drop is steep at the start. */

float melody_fall(float from, float to, float u) {
    static float w1 = 0.0f;
    float t = u < 0.0f ? 0.0f : (u > 1.0f ? 1.0f : u);
    float w;
    if (w1 == 0.0f) w1 = expf(-MELODY_FALL);
    w = expf(-MELODY_FALL * t);
    return to + (from - to) * ((w - w1) / (1.0f - w1));
}

/* Amplitude before velocity. Age 0 is the first sample. Release starts after the gate. */

float melody_level(float age, float gate, float attack, float sustain, float release_sec, int legato, float origin) {
    float span, sus, rise, from, start, room, end, tau, env, up;
    if (age < 0.0f) return 0.0f;
    span = gate < 1.0f ? 1.0f : gate;
    sus = clampf01(sustain);
    rise = legato ? 0.0f : melody_attack_samples(span, attack);
    if (age < span) {
        if (!legato && age < rise) {
            up = (age + 1.0f) / rise;
            return up > 1.0f ? 1.0f : up;
        }
        from = legato ? clampf01(origin) : 1.0f;
        start = legato ? 0.0f : rise;
        room = span - start;
        if (room < 1.0f) room = 1.0f;
        return melody_fall(from, sus, (age - start + 1.0f) / room);
    }
    end = (!legato && rise >= span) ? 1.0f : sus;
    tau = release_sec * SR;
    if (tau < 1.0f) tau = 1.0f;
    env = end * expf(-(age - span + 1.0f) / tau);
    if (env < end * 0.02f) return 0.0f;
    return env;
}

/* Filter opening. 1 is open, 0 is the cutoff knob. Sustain does not hold it. */

float melody_contour(float age, float gate, float attack, int legato, float origin) {
    float span, rise, up, room;
    if (age < 0.0f) return 0.0f;
    span = gate < 1.0f ? 1.0f : gate;
    if (age >= span) return 0.0f;
    if (legato) return melody_fall(clampf01(origin), 0.0f, (age + 1.0f) / span);
    rise = melody_attack_samples(span, attack);
    if (age < rise) {
        up = (age + 1.0f) / rise;
        return up > 1.0f ? 1.0f : up;
    }
    if (rise >= span) return 1.0f;
    room = span - rise;
    return melody_fall(1.0f, 0.0f, (age - rise + 1.0f) / room);
}

/* Sustain knob, or the old pluck inverted. Missing both holds the note. */

float melody_sustain_of(const char *params) {
    float sustain = read_param(params, "sustain", -1.0f);
    float pluck;
    if (sustain >= 0.0f) return clampf01(sustain);
    pluck = read_param(params, "pluck", -1.0f);
    if (pluck >= 0.0f) return 1.0f - clampf01(pluck);
    return 1.0f;
}

float decay_level(float amp, float age, float seconds) {
    float tau, env;
    if (!(amp > 0.0f) || !(seconds > 0.0f) || age < 0.0f) return 0.0f;
    tau = seconds * SR;
    if (tau < 1.0f) tau = 1.0f;
    env = amp * expf(-age / tau);
    if (env < amp * 0.02f) return 0.0f;
    return env;
}

int ticks_to_samples(int ticks, float tempo) {
    float bpm = tempo > 1.0f ? tempo : 120.0f;
    int n = (int)lroundf(((float)ticks * SR * 60.0f) / (bpm * 192.0f));
    return n < 1 ? 1 : n;
}

/** Params once per event. kind 0 is one decay, 1 is snare, 2 is a note. */

void shape_of(const PhraseEv *hit, float tempo, EnvShape *s) {
    s->amp = hit->velocity / 127.0f;
    if (s->amp < 0.0f) s->amp = 0.0f;
    if (s->amp > 1.0f) s->amp = 1.0f;
    s->kind = 0;
    s->a = s->b = s->c = s->hold = s->attack = s->release = 0.0f;
    if (hit->lane == 0) {
        s->a = kick_decay_seconds(read_param(hit->params, "decay", 0.4f));
    } else if (hit->lane == 1) {
        float snap = clampf01(read_param(hit->params, "snap", 0.4f));
        s->kind = 1;
        s->a = snare_body_decay_seconds(read_param(hit->params, "bdcy", 0.3f));
        s->b = snare_noise_decay_seconds(read_param(hit->params, "ndcy", 0.3f));
        s->c = (40.0f + powf(1.0f - snap, 1.4f) * 700.0f) / SR;
    } else if (hit->lane == 2) {
        float ring = clampf01(read_param(hit->params, "ring", 0.3f));
        s->a = hat_decay_seconds(read_param(hit->params, "decay", 0.3f)) * (1.0f + ring * 2.8f);
    } else if (hit->lane == 3) {
        s->a = perc_decay_seconds(read_param(hit->params, "decay", 0.4f));
    } else {
        float release = clampf01(read_param(hit->params, "release", read_param(hit->params, "decay", 0.4f)));
        int ticks = hit->ticks < 1 ? 1 : hit->ticks;
        s->kind = 2;
        s->a = melody_sustain_of(hit->params);
        s->hold = (float)ticks_to_samples(ticks, tempo);
        s->attack = clampf01(read_param(hit->params, "attack", 0.0f));
        s->release = melody_release_seconds(release);
    }
}

float shape_level(const EnvShape *s, float age) {
    float body, noise, click;
    if (s->kind == 2) return s->amp * melody_level(age, s->hold, s->attack, s->a, s->release, 0, 0.0f);
    if (s->kind == 1) {
        body = decay_level(s->amp, age, s->a);
        noise = decay_level(s->amp, age, s->b);
        click = decay_level(s->amp, age, s->c);
        if (noise > body) body = noise;
        if (click > body) body = click;
        return body;
    }
    return decay_level(s->amp, age, s->a);
}

int shape_horizon(const EnvShape *s, int loop) {
    int cap = loop > 0 ? loop * 8 : 8;
    int tail;
    float seconds;
    if (s->kind == 2) tail = (int)s->hold + (int)ceilf(s->release * 4.0f * SR);
    else if (s->kind == 1) {
        seconds = s->a;
        if (s->b > seconds) seconds = s->b;
        if (s->c > seconds) seconds = s->c;
        tail = (int)ceilf(seconds * 4.0f * SR);
    } else tail = (int)ceilf(s->a * 4.0f * SR);
    if (tail < 0) tail = 0;
    if (tail > cap) tail = cap;
    return tail;
}

unsigned env_mix(unsigned h, unsigned v) {
    return (h ^ v) * 16777619u;
}

unsigned envelope_stamp(const Engine *engine) {
    unsigned h = 2166136261u;
    int lane, e, m;
    h = env_mix(h, (unsigned)(engine->tempo * 1000.0f));
    for (e = 0; e < engine->phrase_count; e++) {
        const PhraseEv *hit = &engine->phrase[e];
        const unsigned char *p = (const unsigned char *)hit->params;
        const unsigned char *end = p + sizeof hit->params;
        h = env_mix(h, (unsigned)hit->sample);
        h = env_mix(h, (unsigned)hit->loop);
        h = env_mix(h, (unsigned)hit->lane);
        h = env_mix(h, (unsigned)hit->velocity);
        h = env_mix(h, (unsigned)hit->ticks);
        for (; p < end && *p; p++) h = env_mix(h, *p);
    }
    for (lane = 0; lane < LANE_COUNT; lane++) {
        const LaneBox *box = &engine->lanes[lane];
        for (m = 0; m < box->live_count; m++) {
            if (box->live[m].pattern < 0) h = env_mix(h, (unsigned)box->live[m].pattern);
        }
    }
    return h;
}

static void deposit_env(float *bins, int n, int loop, int hop, int origin, int age, float level) {
    int phase, bin;
    if (!(level > 0.0f)) return;
    phase = origin + age;
    if (loop > 0) phase %= loop;
    if (phase < 0) phase += loop;
    bin = hop > 0 ? phase / hop : 0;
    if (bin >= 0 && bin < n && level > bins[bin]) bins[bin] = level;
}

/* One exp per decay, then a multiply per hop. The closed form is amp·e^(−age/τ). */

static void paint_shape(float *bins, int n, int loop, int hop, int origin, const EnvShape *s) {
    int horizon = shape_horizon(s, loop);
    int age;
    if (hop < 1) hop = 1;
    if (s->kind != 2) {
        double amp = s->amp;
        double sec[3];
        double level[3], coef[3], floor_at[3];
        int live[3];
        int count = s->kind == 1 ? 3 : 1;
        int i;
        sec[0] = s->a;
        sec[1] = s->b;
        sec[2] = s->c;
        for (i = 0; i < count; i++) {
            double tau;
            live[i] = amp > 0.0 && sec[i] > 0.0;
            level[i] = 0.0;
            coef[i] = 1.0;
            floor_at[i] = 0.0;
            if (!live[i]) continue;
            tau = sec[i] * (double)SR;
            if (tau < 1.0) tau = 1.0;
            level[i] = amp;
            coef[i] = exp(-(double)hop / tau);
            floor_at[i] = amp * 0.02;
        }
        for (age = 0; age <= horizon; age += hop) {
            double best = 0.0;
            for (i = 0; i < count; i++) {
                double v;
                if (!live[i]) continue;
                v = level[i];
                level[i] *= coef[i];
                if (v < floor_at[i]) v = 0.0;
                if (v > best) best = v;
            }
            if (age > 0 && best <= 0.0) break;
            deposit_env(bins, n, loop, hop, origin, age, (float)best);
        }
        return;
    }
    {
        double span = s->hold < 1.0f ? 1.0 : (double)s->hold;
        double sus = s->a < 0.0f ? 0.0 : (s->a > 1.0f ? 1.0 : (double)s->a);
        double rise = melody_attack_samples((float)span, s->attack);
        double start = rise;
        double room = span - start;
        double w1, den, fall_k, w = 0.0, rel = 0.0, rel_k, rel_floor, end, tau, amp;
        int fall_on = 0, rel_on = 0;
        if (room < 1.0) room = 1.0;
        w1 = exp(-(double)MELODY_FALL);
        den = 1.0 - w1;
        fall_k = exp(-(double)MELODY_FALL * (double)hop / room);
        end = rise >= span ? 1.0 : sus;
        tau = s->release * (double)SR;
        if (tau < 1.0) tau = 1.0;
        rel_k = exp(-(double)hop / tau);
        rel_floor = end * 0.02;
        amp = s->amp;
        for (age = 0; age <= horizon; age += hop) {
            double unit = 0.0;
            float level;
            if ((double)age < span) {
                if ((double)age < rise) {
                    double up = ((double)age + 1.0) / rise;
                    unit = up > 1.0 ? 1.0 : up;
                } else {
                    double u;
                    if (!fall_on) {
                        u = ((double)age - start + 1.0) / room;
                        if (u < 0.0) u = 0.0;
                        if (u > 1.0) u = 1.0;
                        w = exp(-(double)MELODY_FALL * u);
                        fall_on = 1;
                    } else {
                        w *= fall_k;
                        if (w < w1) w = w1;
                    }
                    unit = sus + (1.0 - sus) * ((w - w1) / den);
                }
            } else {
                if (!rel_on) {
                    rel = end * exp(-((double)age - span + 1.0) / tau);
                    rel_on = 1;
                } else rel *= rel_k;
                if (rel < rel_floor) break;
                unit = rel;
            }
            level = (float)(amp * unit);
            if (age > 0 && level <= 0.0f) break;
            deposit_env(bins, n, loop, hop, origin, age, level);
        }
    }
}

/** Paint each referenced lane once. A per-sample scan of the phrase overran the block. */

void bake_envelopes(Engine *engine) {
    int need[ENV_LANES];
    int lane, e, m;
    unsigned stamp = envelope_stamp(engine);
    float tempo = engine->tempo > 1.0f ? engine->tempo : 120.0f;
    if (engine->env_ready && stamp == engine->env_stamp) return;
    memset(need, 0, sizeof need);
    for (lane = 0; lane < LANE_COUNT; lane++) {
        LaneBox *box = &engine->lanes[lane];
        for (m = 0; m < box->live_count; m++) {
            int pattern = box->live[m].pattern;
            int source = -pattern - 1;
            if (pattern < 0 && source >= 0 && source < ENV_LANES) need[source] = 1;
        }
    }
    for (lane = 0; lane < ENV_LANES; lane++) {
        int loop = 1;
        int hop = ENV_HOP;
        int n;
        engine->env_n[lane] = 0;
        engine->env_loop[lane] = 1;
        engine->env_hop[lane] = hop;
        if (!need[lane]) continue;
        for (e = 0; e < engine->phrase_count; e++) {
            if (engine->phrase[e].lane == lane && engine->phrase[e].loop > loop)
                loop = engine->phrase[e].loop;
        }
        n = (loop + hop - 1) / hop;
        while (n > ENV_CAP && hop < loop && hop < 0x40000000) {
            hop *= 2;
            n = (loop + hop - 1) / hop;
        }
        if (n > ENV_CAP) n = ENV_CAP;
        if (n < 1) n = 1;
        engine->env_loop[lane] = loop;
        engine->env_hop[lane] = hop;
        engine->env_n[lane] = n;
        memset(engine->env[lane], 0, (size_t)n * sizeof(float));
        for (e = 0; e < engine->phrase_count; e++) {
            PhraseEv *hit = &engine->phrase[e];
            EnvShape shape;
            int origin;
            if (hit->lane != lane) continue;
            shape_of(hit, tempo, &shape);
            origin = hit->sample % loop;
            if (origin < 0) origin += loop;
            paint_shape(engine->env[lane], n, loop, hop, origin, &shape);
        }
    }
    engine->env_stamp = stamp;
    engine->env_ready = 1;
}

float baked_envelope(const Engine *engine, int lane, int sample) {
    int n, loop, hop, at, i;
    if (lane < 0 || lane >= ENV_LANES) return 0.0f;
    n = engine->env_n[lane];
    loop = engine->env_loop[lane];
    hop = engine->env_hop[lane];
    if (n < 1 || loop < 1 || hop < 1) return 0.0f;
    at = sample % loop;
    if (at < 0) at += loop;
    i = at / hop;
    if (i >= n) i = n - 1;
    if (i < 0) i = 0;
    return engine->env[lane][i];
}

float eval_voice(const Engine *engine, const LaneMotion *motion, float step, int at) {
    int source;
    if (motion->pattern >= 0) return eval_one(motion->value, motion->pattern, motion->cycle, motion->amount, step);
    if (motion->amount == 0.0f) return clampf01(motion->value);
    source = -motion->pattern - 1;
    /* Same ×3 as applyVoiceEnvelope. Above full scale the value sits at 1. */
    return clampf01(motion->value + baked_envelope(engine, source, at) * motion->amount * 3.0f);
}

void follow_sound(Engine *engine) {
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
        int at = pos % loop;
        float units[LANE_MOTION_CAP];
        for (int m = 0; m < box->live_count; m++) units[m] = eval_voice(engine, &box->live[m], step, at);
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
