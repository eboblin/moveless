#include "engine.h"

int deck_pick(float value, int count) {
    int n = (int)lroundf(value);
    if (n < 0) return 0;
    if (n >= count) return count - 1;
    return n;
}

int deck_mod(int n, int m) {
    if (m <= 1) return 0;
    int r = n % m;
    return r < 0 ? r + m : r;
}

int deck_beat(float tempo) {
    float t = tempo > 1.0f ? tempo : 1.0f;
    return (int)lroundf((SR * 60.0f) / t);
}

int deck_div(const Engine *engine) {
    static const float beats[6] = { 0.125f, 0.25f, 0.5f, 1.0f, 2.0f, 4.0f };
    return (int)fmaxf(1.0f, lroundf(beats[deck_pick(engine->deck_k[0], 6)] * (float)deck_beat(engine->tempo)));
}

int deck_len(const Engine *engine) {
    int sixteenths = (int)lroundf(engine->deck_bar > 1.0f ? engine->deck_bar : 1.0f) * 4;
    if (sixteenths < 1) sixteenths = 1;
    float unit = engine->deck_k[1];
    if (unit < 0.0f) unit = 0.0f;
    if (unit > 1.0f) unit = 1.0f;
    int n = 1 + (int)floorf(unit * (float)sixteenths);
    if (n > sixteenths) n = sixteenths;
    return (int)fmaxf(1.0f, lroundf(((float)n * (float)deck_beat(engine->tempo)) / 4.0f));
}

int deck_brake(const Engine *engine) {
    static const float beats[6] = { 0.0625f, 0.125f, 0.25f, 0.5f, 1.0f, 2.0f };
    return (int)fmaxf(1.0f, lroundf(beats[deck_pick(engine->deck_k[3], 6)] * (float)deck_beat(engine->tempo)));
}

int deck_bar_samples(const Engine *engine) {
    float bars = engine->deck_bar > 1.0f ? engine->deck_bar : 1.0f;
    return (int)fmaxf(1.0f, lroundf(bars * (float)deck_beat(engine->tempo)));
}

int deck_quant(const Engine *engine) {
    int which = deck_pick(engine->deck_k[5], 4);
    if (which == 0) return 1;
    if (which == 1) return deck_div(engine);
    if (which == 2) return deck_beat(engine->tempo);
    return deck_bar_samples(engine);
}

int deck_snap(int sample, int unit) {
    if (unit <= 1) return sample;
    int m = deck_mod(sample, unit);
    return m == 0 ? sample : sample + (unit - m);
}

DeckRead deck_identity(int now) {
    DeckRead r = { (float)now, 1.0f, 1.0f, 0.0f, 1.0f };
    return r;
}

DeckRead deck_stopped(float pos) {
    DeckRead r = { pos, 0.0f, 0.0f, 0.0f, 0.0f };
    return r;
}

float deck_brake_rate(float elapsed, float span) {
    if (elapsed >= span) return 0.0f;
    float k = -logf(0.01f) / span;
    return expf(-k * (elapsed > 0.0f ? elapsed : 0.0f));
}

float deck_brake_pos(float elapsed, float span, float origin) {
    float k = -logf(0.01f) / span;
    if (elapsed >= span) return origin + span / k;
    float t = elapsed > 0.0f ? elapsed : 0.0f;
    return origin + (1.0f - expf(-k * t)) / k;
}

DeckRead deck_spin(float origin, float now, float target) {
    float span = target - origin;
    if (span < 1.0f) span = 1.0f;
    float u = (now - origin) / span;
    if (u < 0.0f) u = 0.0f;
    if (u > 1.0f) u = 1.0f;
    float u2 = u * u;
    float u3 = u2 * u;
    float h00 = 2.0f * u3 - 3.0f * u2 + 1.0f;
    float h01 = -2.0f * u3 + 3.0f * u2;
    float h11 = u3 - u2;
    float d00 = 6.0f * u2 - 6.0f * u;
    float d01 = -6.0f * u2 + 6.0f * u;
    float d11 = 3.0f * u2 - 2.0f * u;
    DeckRead r;
    r.pos = h00 * origin + h01 * target + h11 * span;
    r.rate = (d00 * origin + d01 * target + d11 * span) / span;
    r.live = 0.0f;
    r.gain = 1.0f;
    r.throw_amt = 0.0f;
    return r;
}

void deck_shuffle(unsigned seed, int window_index, int count, int *order) {
    int n = count < 1 ? 1 : count > 48 ? 48 : count;
    for (int i = 0; i < n; i++) order[i] = i;
    unsigned state = (unsigned)((seed + 1) * 997 + (unsigned)(window_index + 1) * 131);
    for (int i = n - 1; i > 0; i--) {
        state = state * 1664525u + 1013904223u;
        int j = (int)(state % (unsigned)(i + 1));
        int swap = order[i];
        order[i] = order[j];
        order[j] = swap;
    }
}

unsigned deck_hash(unsigned seed, int window_index, int slot, int salt) {
    unsigned state = (seed + 1u) * 997u + (unsigned)(window_index + 1) * 131u + (unsigned)(slot + 1) * (unsigned)salt;
    state = state * 1664525u + 1013904223u;
    return state;
}

/** One bar of slices. A downbeat hit lands on the offbeat; holding stutters it and may jump an octave. */

DeckRead deck_glitch(const Engine *engine, int origin, int now, int y) {
    static const float speed[4] = { 1.0f, 2.0f, 0.5f, 1.0f };
    static const int row_bias[4] = { 0, 0, 1, 2 };
    int beat = deck_beat(engine->tempo);
    int bar = deck_bar_samples(engine);
    int slice = deck_div(engine);
    int count, window, held, per, slip, cuts, grain, slot, src, local, at, src_off, start;
    int order[32];
    int bucket[32];
    int fill = 0;
    int bias, steps, finest, window_index, jump, src_phase, pick;
    float rate = 1.0f;
    DeckRead r;
    if (beat < 1) beat = 1;
    if (slice < 1) slice = 1;
    if (y < 0) y = 0;
    if (y > 3) y = 3;
    count = bar / slice;
    if (count < 1) count = 1;
    if (count > 32) count = 32;
    window = count * slice;
    start = engine->deck_lead >= window ? origin : origin - window;
    held = now - origin;
    if (held < 0) held = 0;
    per = (int)lroundf((float)beat / (float)slice);
    if (per < 1) per = 1;
    slip = per >= 2 ? 0 : beat / 2;
    bias = row_bias[y];
    steps = bias + held / beat;
    if (steps > 3) steps = 3;
    if (steps < 0) steps = 0;
    cuts = 1 << steps;
    finest = (int)lroundf((float)beat / 8.0f);
    if (finest < 1) finest = 1;
    while (cuts > 1 && slice / cuts < finest) cuts >>= 1;
    grain = slice / cuts;
    if (grain < 1) grain = 1;
    window_index = window > 0 ? held / window : 0;
    slot = held / slice;
    if (cuts > 1) rate = speed[deck_hash((unsigned)engine->deck_seed, 0, deck_mod(slot, count), 17) % 4u];
    jump = y % 2 == 1;
    deck_shuffle((unsigned)engine->deck_seed, window_index, count, order);
    src = order[deck_mod(slot, count)];
    if (per < 2) {
        if (jump) src = (int)(deck_hash((unsigned)engine->deck_seed, window_index, slot, 47) % (unsigned)count);
    } else {
        src_phase = deck_mod(deck_mod(slot, per) - per / 2, per);
        for (pick = 0; pick < count; pick++) {
            if (deck_mod(order[pick], per) == src_phase && fill < 32) bucket[fill++] = order[pick];
        }
        if (fill > 0) {
            if (jump) src = bucket[deck_hash((unsigned)engine->deck_seed, window_index, slot, 47) % (unsigned)fill];
            else src = bucket[deck_mod(slot / per, fill)];
        }
    }
    local = deck_mod(deck_mod(held, slice) - slip, slice);
    at = local % grain;
    src_off = at;
    if (rate > 1.5f) src_off = (at * 2) % grain;
    else if (rate < 0.75f) src_off = at / 2;
    r.pos = (float)(start + src * slice + src_off);
    r.live = 0.0f;
    r.gain = 1.0f;
    r.throw_amt = 0.0f;
    r.rate = rate;
    return r;
}

float deck_unit(float value) {
    if (value < 0.0f) return 0.0f;
    if (value > 1.0f) return 1.0f;
    return value;
}

/** Centre is the written hand. The left third reverses; either side leans into that stroke. */

void deck_scratch_clock(float phase, float ramp, float *out_phase, float *dir, float *d_warp) {
    float centered = deck_unit(ramp) * 2.0f - 1.0f;
    float lean = centered * 2.0f;
    float exp, p, q;
    *dir = 1.0f;
    if (centered < -0.5f) {
        *dir = -1.0f;
        lean = (-centered - 0.5f) / 0.5f;
    }
    if (lean > 1.0f) lean = 1.0f;
    if (lean < -1.0f) lean = -1.0f;
    exp = 1.0f + fabsf(lean) * 1.35f;
    p = phase;
    if (p < 0.0f) p = 0.0f;
    if (p > 1.0f) p = 1.0f;
    if (p <= 0.0f) {
        *out_phase = 0.0f;
        *d_warp = 0.0f;
        return;
    }
    if (p >= 1.0f) {
        *out_phase = 1.0f;
        *d_warp = exp;
        return;
    }
    if (lean >= 0.0f) {
        *out_phase = powf(p, exp);
        *d_warp = exp * powf(p, exp - 1.0f);
        return;
    }
    q = 1.0f - p;
    *out_phase = 1.0f - powf(q, exp);
    *d_warp = exp * powf(q, exp - 1.0f);
}

void deck_scratch_hand(int shape, float phase, float *pos, float *dpos) {
    if (shape == 1) {
        static const float p[5] = { 0.0f, 0.18f, 0.30f, 0.50f, 1.0f };
        static const float v[5] = { 0.0f, 0.70f, 0.34f, 1.0f, 0.0f };
        int i = 0;
        float span, t;
        while (i < 3 && phase >= p[i + 1]) i++;
        span = p[i + 1] - p[i];
        t = span > 0.0f ? (phase - p[i]) / span : 0.0f;
        *pos = v[i] + (v[i + 1] - v[i]) * t;
        *dpos = span > 0.0f ? (v[i + 1] - v[i]) / span : 0.0f;
        return;
    }
    if (shape == 2) {
        float t, s;
        if (phase < 0.8f) {
            t = phase / 0.8f;
            s = sinf(3.14159265f * t);
            *pos = -(0.5f - 0.5f * cosf(3.14159265f * t));
            *dpos = -(0.5f * 3.14159265f * s) / 0.8f;
            return;
        }
        t = (phase - 0.8f) / 0.2f;
        s = sinf(3.14159265f * t);
        *pos = -(1.0f - (0.5f - 0.5f * cosf(3.14159265f * t)));
        *dpos = (0.5f * 3.14159265f * s) / 0.2f;
        return;
    }
    if (shape == 3) {
        *pos = sinf(6.2831853f * phase);
        *dpos = 6.2831853f * cosf(6.2831853f * phase);
        return;
    }
    *pos = sinf(3.14159265f * phase);
    *dpos = 3.14159265f * cosf(3.14159265f * phase);
}

void deck_scratch_stroke(int shape, float phase, int *note, float *local) {
    if (shape == 3) {
        int q = (int)floorf(phase * 4.0f);
        if (q < 0) q = 0;
        if (q > 3) q = 3;
        *note = (q % 2) == 0;
        *local = (phase - (float)q * 0.25f) / 0.25f;
        return;
    }
    {
        float split = shape == 2 ? 0.8f : 0.5f;
        if (phase < split) {
            *note = 1;
            *local = split > 0.0f ? phase / split : 0.0f;
            return;
        }
        *note = 0;
        *local = (phase - split) / (1.0f - split);
    }
}

float deck_scratch_gain(int note, float local, float cut) {
    float shut = deck_unit(cut) * 1.4f;
    if (shut > 1.0f) shut = 1.0f;
    if (!note || local < shut * 0.2f || local > 1.0f - shut * 0.2f) return 1.0f - shut;
    return 1.0f;
}

/* Same roll as scratchRoll in src/core/deck.ts. A press, a complexity and a length. */

unsigned scratch_next(unsigned state) {
    return state * 1664525u + 1013904223u;
}

void deck_scratch_roll(int duration_index, int complexity, int seed, int press,
    int *lens, int *types, int *signs, int *count, int *sum) {
    static const int durs[] = { 2, 4, 6, 8, 12, 16 };
    static const int bags[4][4] = {
        { 2, 2, 2, 1 },
        { 2, 2, 1, 1 },
        { 2, 1, 3, 1 },
        { 1, 1, 2, 3 }
    };
    int level = complexity;
    int dur, span, left, root, nfit, i, len, type, sign;
    int fit[4];
    unsigned state;
    if (duration_index < 0) duration_index = 0;
    if (duration_index > 5) duration_index = 5;
    if (level < 0) level = 0;
    if (level > 3) level = 3;
    dur = durs[duration_index];
    span = level == 0 ? 1 : level == 1 ? 2 : level == 2 ? 3 : 4;
    state = ((unsigned)(seed + 1) * 997u) ^ ((unsigned)(press + 1) * 131u)
        ^ ((unsigned)(level + 3) * 17u) ^ ((unsigned)(dur + 5) * 53u);
    state = scratch_next(state);
    root = (int)(state % 4u);
    left = dur;
    *count = 0;
    *sum = 0;
    while (left > 0 && *count < 16) {
        nfit = 0;
        for (i = 0; i < 4; i++) {
            if (bags[level][i] <= left) fit[nfit++] = bags[level][i];
        }
        if (nfit == 0) fit[nfit++] = left > 3 ? 3 : left;
        state = scratch_next(state);
        len = fit[state % (unsigned)nfit];
        state = scratch_next(state);
        type = (root + (int)(state % (unsigned)span)) % 4;
        state = scratch_next(state);
        sign = level >= 2 && (state % 4u) == 0u ? -1 : 1;
        lens[*count] = len;
        types[*count] = type;
        signs[*count] = sign;
        *count += 1;
        *sum += len;
        left -= len;
    }
}

/** A fresh sentence of short scratches. The row is the mix, the column is the length. */

DeckRead deck_scratch(const Engine *engine, int origin, int now, int len, int shape) {
    float beat = (SR * 60.0f) / (engine->tempo > 1.0f ? engine->tempo : 1.0f);
    int sixteenth = (int)lroundf(beat / 4.0f);
    int lens[16], types[16], signs[16];
    int count = 0, sum = 0, held, pos, acc, i, span, start, cycles, cycle, note_at, cue;
    int which = 0, sign = 1, note = 1;
    float unit, raw, phase = 0.0f, dir = 1.0f, d_warp = 1.0f, reach, hand, dpos, local;
    DeckRead r;
    (void)len;
    if (sixteenth < 1) sixteenth = 1;
    deck_scratch_roll(deck_pick(engine->deck_k[3], 6), shape, engine->deck_seed, engine->deck_serial,
        lens, types, signs, &count, &sum);
    cycle = sum * sixteenth;
    if (cycle < 1) cycle = 1;
    held = now - origin;
    pos = deck_mod(held, cycle);
    acc = 0;
    start = 0;
    span = sixteenth;
    if (count > 0) {
        which = types[0];
        sign = signs[0];
    }
    for (i = 0; i < count; i++) {
        int next = lens[i] * sixteenth;
        if (next < 1) next = 1;
        if (pos < acc + next) {
            start = acc;
            span = next;
            which = types[i];
            sign = signs[i];
            break;
        }
        acc += next;
    }
    cycles = held > 0 ? held / cycle : 0;
    note_at = origin + cycles * cycle + start;
    unit = deck_unit(engine->deck_k[1]);
    cue = (int)lroundf(fabsf(unit - 0.5f) * 8.0f);
    raw = span > 1 ? (float)(now - note_at) / (float)span : 0.0f;
    deck_scratch_clock(raw, engine->deck_k[7], &phase, &dir, &d_warp);
    dir *= (float)sign;
    reach = (0.08f + deck_unit(engine->deck_k[4]) * 0.92f) * (float)span;
    if (reach < 1.0f) reach = 1.0f;
    deck_scratch_hand(which, phase, &hand, &dpos);
    deck_scratch_stroke(which, phase, &note, &local);
    r.pos = (float)(note_at - cue * sixteenth) + hand * reach * dir;
    r.live = 0.0f;
    r.gain = deck_scratch_gain(note, local, engine->deck_k[6]);
    r.throw_amt = 0.0f;
    r.rate = (dpos * d_warp * reach * dir) / (float)span;
    return r;
}

/* Group x row, same order as readGroup: rpt lop glc scr gat pch stp thr, row 0..3.
 * Legacy names follow gestureRead's ids: roll through thrw. Curves are the old branches. */

typedef DeckRead (*DeckRowFn)(const Engine *engine, int origin, int now, int div, int len, int bar, int beat, int held, float ramp);
typedef DeckRead (*LegacyFn)(const Engine *engine, int origin, int now, int div, int len, int bar);

#define BIND_ROW(group, y) \
    static DeckRead row_##group##_##y(const Engine *engine, int origin, int now, int div, int len, int bar, int beat, int held, float ramp) { \
        return read_##group(engine, y, origin, now, div, len, bar, beat, held, ramp); \
    }

static DeckRead read_rpt(const Engine *engine, int y, int origin, int now, int div, int len, int bar, int beat, int held, float ramp) {
    int start = origin - deck_mod(origin, div) - div;
    (void)engine;
    (void)len;
    (void)beat;
    (void)ramp;
    if (y == 1) {
        DeckRead r = { (float)(origin - deck_mod(origin, bar) + deck_mod(held, div)), 0.0f, 1.0f, 0.0f, 1.0f };
        return r;
    }
    if (y == 2) {
        int into = deck_mod(held, div);
        DeckRead r = { (float)(start + div - into), 0.0f, 1.0f, 0.0f, -1.0f };
        return r;
    }
    if (y == 3) {
        int period = div * 2;
        int m = deck_mod(held, period > 1 ? period : 1);
        DeckRead r;
        r.live = 0.0f;
        r.gain = 1.0f;
        r.throw_amt = 0.0f;
        if (m <= div) {
            r.pos = (float)(start + m);
            r.rate = 1.0f;
        } else {
            r.pos = (float)(start + period - m);
            r.rate = -1.0f;
        }
        return r;
    }
    DeckRead r = { (float)(start + deck_mod(held, div)), 0.0f, 1.0f, 0.0f, 1.0f };
    return r;
}

static DeckRead read_lop(const Engine *engine, int y, int origin, int now, int div, int len, int bar, int beat, int held, float ramp) {
    int start = origin - len;
    (void)div;
    (void)bar;
    (void)ramp;
    if (y == 1) {
        int future = engine->deck_lead >= len;
        if (now >= origin + len) return deck_identity(now);
        DeckRead r = { (float)((future ? origin + len : origin) - held), 0.0f, 1.0f, 0.0f, -1.0f };
        return r;
    }
    if (y == 2) {
        int period = len * 2;
        int m = deck_mod(held, period > 1 ? period : 1);
        DeckRead r = { 0.0f, 0.0f, 1.0f, 0.0f, 1.0f };
        if (m <= len) r.pos = (float)(start + m);
        else {
            r.pos = (float)(start + period - m);
            r.rate = -1.0f;
        }
        return r;
    }
    if (y == 3) {
        int step = beat / 4;
        int cycles;
        if (step < 1) step = 1;
        cycles = len > 0 ? held / len : 0;
        DeckRead r = { (float)(start + cycles * step + deck_mod(held, len > 0 ? len : 1)), 0.0f, 1.0f, 0.0f, 1.0f };
        return r;
    }
    DeckRead r = { (float)(start + deck_mod(held, len > 0 ? len : 1)), 0.0f, 1.0f, 0.0f, 1.0f };
    return r;
}

static DeckRead read_glc(const Engine *engine, int y, int origin, int now, int div, int len, int bar, int beat, int held, float ramp) {
    (void)div;
    (void)len;
    (void)bar;
    (void)beat;
    (void)held;
    (void)ramp;
    return deck_glitch(engine, origin, now, y);
}

static DeckRead read_scr(const Engine *engine, int y, int origin, int now, int div, int len, int bar, int beat, int held, float ramp) {
    (void)div;
    (void)bar;
    (void)beat;
    (void)held;
    (void)ramp;
    return deck_scratch(engine, origin, now, len, y);
}

static DeckRead read_gat(const Engine *engine, int y, int origin, int now, int div, int len, int bar, int beat, int held, float ramp) {
    float base = y == 1 ? 0.28f : y == 2 ? 0.1f : 0.5f;
    float duty = base + (deck_unit(engine->deck_k[6]) - 0.5f) * 0.3f;
    int into = deck_mod(held, div);
    int on;
    DeckRead r = { (float)now, 1.0f, 0.0f, 0.0f, 1.0f };
    (void)origin;
    (void)len;
    (void)bar;
    (void)beat;
    (void)ramp;
    if (duty < 0.02f) duty = 0.02f;
    if (duty > 0.95f) duty = 0.95f;
    if (y == 3) on = into >= (int)((float)div * (1.0f - duty));
    else on = into < (int)((float)div * duty);
    r.gain = on ? 1.0f : 0.0f;
    return r;
}

static DeckRead read_pch(const Engine *engine, int y, int origin, int now, int div, int len, int bar, int beat, int held, float ramp) {
    static const float pitch_rate[6] = { 0.5f, 0.75f, 1.0f, 1.5f, 2.0f, 4.0f };
    float base = pitch_rate[deck_pick(engine->deck_k[0], 6)] * (1.0f + (ramp - 0.5f) * 0.5f);
    float u = (float)held / (float)bar;
    float rate = base;
    float consumed;
    DeckRead r;
    (void)div;
    (void)len;
    if (u < 0.0f) u = 0.0f;
    if (u > 1.0f) u = 1.0f;
    if (y == 1) rate = base * (1.0f + u);
    else if (y == 2) rate = base * (1.0f - 0.5f * u);
    else if (y == 3) rate = base * (1.0f + 0.12f * sinf(6.2831853f * (float)held / (float)beat));
    if (y == 1) {
        consumed = held <= bar
            ? base * ((float)held + ((float)held * (float)held) / (2.0f * (float)bar))
            : base * ((float)bar * 1.5f) + base * 2.0f * (float)(held - bar);
    } else if (y == 2) {
        consumed = held <= bar
            ? base * ((float)held - ((float)held * (float)held) / (4.0f * (float)bar))
            : base * ((float)bar * 0.75f) + base * 0.5f * (float)(held - bar);
    } else if (y == 3) {
        float swing = (0.12f * (float)beat) / 6.2831853f;
        consumed = base * ((float)held - swing * (cosf(6.2831853f * (float)held / (float)beat) - 1.0f));
    } else consumed = (float)held * base;
    r.pos = (float)origin + consumed;
    r.rate = rate;
    r.live = 0.0f;
    r.gain = 1.0f;
    r.throw_amt = 0.0f;
    if (r.pos > (float)(now + engine->deck_lead) && rate > 1.0f) {
        int start = origin - beat;
        int traveled = (int)lroundf(r.pos - (float)origin);
        r.pos = (float)(start + deck_mod(traveled, beat > 0 ? beat : 1));
    }
    return r;
}

static DeckRead read_stp(const Engine *engine, int y, int origin, int now, int div, int len, int bar, int beat, int held, float ramp) {
    int span = deck_brake(engine);
    (void)div;
    (void)len;
    (void)beat;
    (void)ramp;
    if (y == 1) {
        int target = deck_snap(origin + 1, bar);
        if (target - origin < span) target += bar;
        if (now >= target) return deck_identity(now);
        return deck_spin((float)origin, (float)now, (float)target);
    }
    if (y == 2) {
        float u = (float)held / (float)span;
        DeckRead r;
        if (u >= 1.0f) return deck_identity(now);
        r.pos = (float)origin + (float)span * (2.0f / 3.14159265f) * (cosf(3.14159265f * u) - 1.0f);
        r.rate = -2.0f * sinf(3.14159265f * u);
        r.live = 0.0f;
        r.gain = 1.0f;
        r.throw_amt = 0.0f;
        return r;
    }
    if (y == 3) {
        float parked = deck_brake_pos((float)span, (float)span, (float)origin);
        float hop, u;
        DeckRead r;
        if (held <= span) {
            float rate = deck_brake_rate((float)held, (float)span);
            if (rate < 0.02f) {
                r.pos = parked;
                r.rate = rate;
                r.live = 0.0f;
                r.gain = 1.0f;
                r.throw_amt = 0.0f;
                return r;
            }
            r.pos = deck_brake_pos((float)held, (float)span, (float)origin);
            r.rate = rate;
            r.live = 0.0f;
            r.gain = 1.0f;
            r.throw_amt = 0.0f;
            return r;
        }
        hop = (float)span * 0.35f;
        if ((float)held >= (float)span + hop) return deck_stopped(parked);
        u = ((float)held - (float)span) / hop;
        r.pos = parked - sinf(3.14159265f * u) * (float)span * 0.12f;
        r.rate = -cosf(3.14159265f * u);
        r.live = 0.0f;
        r.gain = 1.0f;
        r.throw_amt = 0.0f;
        return r;
    }
    {
        float rate = deck_brake_rate((float)held, (float)span);
        if (rate < 0.02f) return deck_stopped(deck_brake_pos((float)span, (float)span, (float)origin));
        DeckRead r = { deck_brake_pos((float)held, (float)span, (float)origin), 0.0f, 1.0f, 0.0f, rate };
        return r;
    }
}

static DeckRead read_thr(const Engine *engine, int y, int origin, int now, int div, int len, int bar, int beat, int held, float ramp) {
    int open = div;
    float levels[4] = { 0.35f, 1.0f, 1.0f, 1.5f };
    float amt = 0.0f;
    DeckRead r = { (float)now, 1.0f, 1.0f, 0.0f, 1.0f };
    (void)engine;
    (void)origin;
    (void)len;
    (void)ramp;
    if (held < open) amt = levels[y];
    else if (y == 2) {
        float u = (float)(held - open) / (float)bar;
        amt = u >= 1.0f ? 0.0f : expf(-3.0f * u);
    } else if (y == 3) {
        float u = (float)(held - open) / (float)beat;
        amt = u >= 1.0f ? 0.0f : 1.5f * (1.0f - u);
    }
    r.throw_amt = amt;
    return r;
}

BIND_ROW(rpt, 0)
BIND_ROW(rpt, 1)
BIND_ROW(rpt, 2)
BIND_ROW(rpt, 3)
BIND_ROW(lop, 0)
BIND_ROW(lop, 1)
BIND_ROW(lop, 2)
BIND_ROW(lop, 3)
BIND_ROW(glc, 0)
BIND_ROW(glc, 1)
BIND_ROW(glc, 2)
BIND_ROW(glc, 3)
BIND_ROW(scr, 0)
BIND_ROW(scr, 1)
BIND_ROW(scr, 2)
BIND_ROW(scr, 3)
BIND_ROW(gat, 0)
BIND_ROW(gat, 1)
BIND_ROW(gat, 2)
BIND_ROW(gat, 3)
BIND_ROW(pch, 0)
BIND_ROW(pch, 1)
BIND_ROW(pch, 2)
BIND_ROW(pch, 3)
BIND_ROW(stp, 0)
BIND_ROW(stp, 1)
BIND_ROW(stp, 2)
BIND_ROW(stp, 3)
BIND_ROW(thr, 0)
BIND_ROW(thr, 1)
BIND_ROW(thr, 2)
BIND_ROW(thr, 3)

static const DeckRowFn GROUP_ROW[8][4] = {
    { row_rpt_0, row_rpt_1, row_rpt_2, row_rpt_3 },
    { row_lop_0, row_lop_1, row_lop_2, row_lop_3 },
    { row_glc_0, row_glc_1, row_glc_2, row_glc_3 },
    { row_scr_0, row_scr_1, row_scr_2, row_scr_3 },
    { row_gat_0, row_gat_1, row_gat_2, row_gat_3 },
    { row_pch_0, row_pch_1, row_pch_2, row_pch_3 },
    { row_stp_0, row_stp_1, row_stp_2, row_stp_3 },
    { row_thr_0, row_thr_1, row_thr_2, row_thr_3 },
};

static DeckRead legacy_roll(const Engine *engine, int origin, int now, int div, int len, int bar) {
    int slice = div;
    int start = origin - deck_mod(origin, slice) - slice;
    DeckRead r = { (float)(start + deck_mod(now - origin, slice)), 0.0f, 1.0f, 0.0f, 1.0f };
    (void)engine;
    (void)len;
    (void)bar;
    return r;
}

static DeckRead legacy_stut(const Engine *engine, int origin, int now, int div, int len, int bar) {
    int slice = (int)fmaxf(1.0f, lroundf((float)div / 2.0f));
    int start = origin - deck_mod(origin, slice) - slice;
    DeckRead r = { (float)(start + deck_mod(now - origin, slice)), 0.0f, 1.0f, 0.0f, 1.0f };
    (void)engine;
    (void)len;
    (void)bar;
    return r;
}

static DeckRead legacy_loop(const Engine *engine, int origin, int now, int div, int len, int bar) {
    DeckRead r = { (float)(origin - len + deck_mod(now - origin, len)), 0.0f, 1.0f, 0.0f, 1.0f };
    (void)engine;
    (void)div;
    (void)bar;
    return r;
}

static DeckRead legacy_rev(const Engine *engine, int origin, int now, int div, int len, int bar) {
    int future = engine->deck_lead >= len;
    (void)div;
    (void)bar;
    if (now >= origin + len) return deck_identity(now);
    int window_end = future ? origin + len : origin;
    DeckRead r = { (float)(window_end - (now - origin)), 0.0f, 1.0f, 0.0f, -1.0f };
    return r;
}

static DeckRead legacy_jump(const Engine *engine, int origin, int now, int div, int len, int bar) {
    int start = origin - deck_mod(origin, bar);
    DeckRead r = { (float)(start + deck_mod(now - origin, div)), 0.0f, 1.0f, 0.0f, 1.0f };
    (void)engine;
    (void)len;
    return r;
}

static DeckRead legacy_glch(const Engine *engine, int origin, int now, int div, int len, int bar) {
    (void)div;
    (void)len;
    (void)bar;
    return deck_glitch(engine, origin, now, 0);
}

static DeckRead legacy_tran(const Engine *engine, int origin, int now, int div, int len, int bar) {
    float duty = 0.05f + (engine->deck_k[6] < 0.0f ? 0.0f : engine->deck_k[6] > 1.0f ? 1.0f : engine->deck_k[6]) * 0.9f;
    int on = deck_mod(now - origin, div) < (int)((float)div * duty);
    DeckRead r = { (float)now, 1.0f, on ? 1.0f : 0.0f, 0.0f, 1.0f };
    (void)len;
    (void)bar;
    return r;
}

static DeckRead legacy_drop(const Engine *engine, int origin, int now, int div, int len, int bar) {
    DeckRead r = { (float)now, 1.0f, 0.0f, 0.0f, 1.0f };
    (void)engine;
    (void)origin;
    (void)div;
    (void)len;
    (void)bar;
    return r;
}

static DeckRead legacy_half(const Engine *engine, int origin, int now, int div, int len, int bar) {
    DeckRead r = { (float)origin + (float)(now - origin) * 0.5f, 0.0f, 1.0f, 0.0f, 0.5f };
    (void)engine;
    (void)div;
    (void)len;
    (void)bar;
    return r;
}

static DeckRead legacy_dbl(const Engine *engine, int origin, int now, int div, int len, int bar) {
    int ran = (now - origin) * 2;
    (void)len;
    (void)bar;
    if (origin + ran <= now + engine->deck_lead) {
        DeckRead r = { (float)(origin + ran), 0.0f, 1.0f, 0.0f, 2.0f };
        return r;
    }
    DeckRead r = { (float)(origin - div + deck_mod(ran, div)), 0.0f, 1.0f, 0.0f, 2.0f };
    return r;
}

static DeckRead legacy_stop(const Engine *engine, int origin, int now, int div, int len, int bar) {
    float span = (float)deck_brake(engine);
    float elapsed = (float)(now - origin);
    float rate = deck_brake_rate(elapsed, span);
    (void)div;
    (void)len;
    (void)bar;
    if (rate < 0.02f) return deck_stopped(deck_brake_pos(span, span, (float)origin));
    DeckRead r = { deck_brake_pos(elapsed, span, (float)origin), 0.0f, 1.0f, 0.0f, rate };
    return r;
}

static DeckRead legacy_spin(const Engine *engine, int origin, int now, int div, int len, int bar) {
    int target = deck_snap(origin + 1, bar);
    (void)div;
    (void)len;
    if (target - origin < deck_brake(engine)) target += bar;
    if (now >= target) return deck_identity(now);
    return deck_spin((float)origin, (float)now, (float)target);
}

static DeckRead legacy_back(const Engine *engine, int origin, int now, int div, int len, int bar) {
    float beat = (float)deck_beat(engine->tempo);
    float u = (float)(now - origin) / beat;
    DeckRead r;
    (void)div;
    (void)len;
    (void)bar;
    if (u >= 1.0f) return deck_identity(now);
    r.pos = (float)origin + beat * (2.0f / 3.14159265f) * (cosf(3.14159265f * u) - 1.0f);
    r.rate = -2.0f * sinf(3.14159265f * u);
    r.live = 0.0f;
    r.gain = 1.0f;
    r.throw_amt = 0.0f;
    return r;
}

static DeckRead legacy_scr(const Engine *engine, int origin, int now, int div, int len, int bar) {
    (void)div;
    (void)bar;
    return deck_scratch(engine, origin, now, len, 0);
}

static DeckRead legacy_hlx(const Engine *engine, int origin, int now, int div, int len, int bar) {
    int slice = div;
    int start = origin - deck_mod(origin, slice) - slice;
    float held = (float)(now - origin);
    float rise = held / (float)bar;
    float ramp, rate, consumed;
    DeckRead r;
    (void)len;
    if (rise > 1.0f) rise = 1.0f;
    if (rise < 0.0f) rise = 0.0f;
    ramp = engine->deck_k[7] > 0.0f ? engine->deck_k[7] : 0.0f;
    rate = 1.0f + ramp * rise * 3.0f;
    consumed = held <= (float)bar ? held + (ramp * 3.0f * held * held) / (2.0f * (float)bar) : held * rate;
    r.pos = (float)start + (float)deck_mod((int)lroundf(consumed), slice);
    r.live = 0.0f;
    r.gain = 1.0f;
    r.throw_amt = 0.0f;
    r.rate = rate;
    return r;
}

static DeckRead legacy_thrw(const Engine *engine, int origin, int now, int div, int len, int bar) {
    DeckRead r = { (float)now, 1.0f, 1.0f, 1.0f, 1.0f };
    (void)engine;
    (void)origin;
    (void)div;
    (void)len;
    (void)bar;
    return r;
}

/* roll stut loop rev jump glch tran drop half dbl stop spin back scr hlx thrw */
static const LegacyFn LEGACY[16] = {
    legacy_roll, legacy_stut, legacy_loop, legacy_rev, legacy_jump, legacy_glch, legacy_tran, legacy_drop,
    legacy_half, legacy_dbl, legacy_stop, legacy_spin, legacy_back, legacy_scr, legacy_hlx, legacy_thrw,
};

/** Group gestures are 16 + group * 4 + row. The row is the field's Y. */

DeckRead deck_group(const Engine *engine, int gesture, int now) {
    int at = gesture - 16;
    int group = at / 4;
    int y = at % 4;
    int div = deck_div(engine);
    int len = deck_len(engine);
    int bar = deck_bar_samples(engine);
    int beat = deck_beat(engine->tempo);
    int origin = group == 6 ? engine->deck_down : deck_snap(engine->deck_down, deck_quant(engine));
    int held;
    float ramp;
    if (now < origin) return deck_identity(now);
    held = now - origin;
    ramp = deck_unit(engine->deck_k[7]);
    if (group < 0 || group > 7) group = 7;
    if (y < 0) y = 0;
    if (y > 3) y = 3;
    return GROUP_ROW[group][y](engine, origin, now, div, len, bar, beat, held, ramp);
}

DeckRead deck_gesture(const Engine *engine, int gesture, int now) {
    if (gesture >= 16) return deck_group(engine, gesture, now);
    int div = deck_div(engine);
    int len = deck_len(engine);
    int bar = deck_bar_samples(engine);
    int immediate = gesture == 10 || gesture == 11;
    int origin = immediate ? engine->deck_down : deck_snap(engine->deck_down, deck_quant(engine));
    if (now < origin) return deck_identity(now);
    if (gesture < 0 || gesture > 15) gesture = 15;
    return LEGACY[gesture](engine, origin, now, div, len, bar);
}

DeckRead deck_read(Engine *engine) {
    int now = engine->clock;
    int gesture = engine->deck_gesture;
    if (gesture < 0) return deck_identity(now);
    DeckRead wet = deck_gesture(engine, gesture, now);
    if (engine->deck_up < 0 || now < engine->deck_up) return wet;
    float t = (float)(now - engine->deck_up) / (float)DECK_FADE;
    if (t > 1.0f) t = 1.0f;
    if (t < 0.0f) t = 0.0f;
    float dry = sinf(t * 1.5707963f);
    float keep = cosf(t * 1.5707963f);
    wet.live = wet.live * keep + dry;
    wet.gain = wet.gain * keep + dry;
    wet.throw_amt *= keep;
    wet.rate = wet.rate * keep + dry;
    return wet;
}

/* Send into the throw line. Depth scales the return, not this send. */

float deck_throw(Engine *engine) {
    if (engine->deck_gesture < 0) return 0.0f;
    return deck_read(engine).throw_amt;
}

/* thrw is the legacy name and uses EVEN. Group thr is 16 + 7 * 4 + row. */

int throw_row(int gesture) {
    if (gesture == 15) return 1;
    if (gesture >= 44 && gesture <= 47) return gesture - 44;
    return -1;
}

void deck_peak_note(Engine *engine, int now, float left, float right) {
    if (!engine->deck_peak_l || !engine->deck_peak_r || now < 0) return;
    int hop = (now >> 7) & (DECK_PEAKS - 1);
    if ((now & (DECK_HOP - 1)) == 0) {
        engine->deck_peak_l[hop] = 0.0f;
        engine->deck_peak_r[hop] = 0.0f;
    }
    float al = fabsf(left);
    float ar = fabsf(right);
    if (al > engine->deck_peak_l[hop]) engine->deck_peak_l[hop] = al;
    if (ar > engine->deck_peak_r[hop]) engine->deck_peak_r[hop] = ar;
}

void deck_hear(Engine *engine, float *l, float *r) {
    int now = engine->clock;
    int mask = engine->deck_mask;
    if (engine->deck_l && mask > 0) {
        engine->deck_l[now & mask] = *l;
        engine->deck_r[now & mask] = *r;
        if (now + 1 > engine->deck_filled) engine->deck_filled = now + 1;
        deck_peak_note(engine, now, *l, *r);
    }
    if (engine->deck_gesture < 0) return;
    DeckRead read = deck_read(engine);
    float src_l = *l;
    float src_r = *r;
    if (read.live < 1.0f && engine->deck_l) {
        int i0 = (int)floorf(read.pos);
        if (i0 >= 0 && i0 < engine->deck_filled) {
            float frac = read.pos - (float)i0;
            int a = i0 & mask;
            int b = (i0 + 1) & mask;
            int b_ok = i0 + 1 < engine->deck_filled;
            float l0 = engine->deck_l[a];
            float r0 = engine->deck_r[a];
            float l1 = b_ok ? engine->deck_l[b] : l0;
            float r1 = b_ok ? engine->deck_r[b] : r0;
            src_l = l0 * (1.0f - frac) + l1 * frac;
            src_r = r0 * (1.0f - frac) + r1 * frac;
        } else {
            src_l = 0.0f;
            src_r = 0.0f;
        }
    }
    float wet_l = (*l * read.live + src_l * (1.0f - read.live)) * read.gain;
    float wet_r = (*r * read.live + src_r * (1.0f - read.live)) * read.gain;
    float depth = engine->deck_k[2];
    if (depth < 0.0f) depth = 0.0f;
    if (depth > 1.0f) depth = 1.0f;
    *l = *l * (1.0f - depth) + wet_l * depth;
    *r = *r * (1.0f - depth) + wet_r * depth;
    if (engine->deck_up >= 0 && now >= engine->deck_up + DECK_FADE) engine->deck_gesture = -1;
}

/** Read position the strip should sit on, once per block. */

void deck_capture_view(Engine *engine) {
    int now = engine->clock;
    DeckRead read = deck_read(engine);
    float head = (float)now * read.live + read.pos * (1.0f - read.live);
    engine->deck_view_head = (int)lroundf(head);
    float tempo = engine->tempo > 1.0f ? engine->tempo : 120.0f;
    int beat = deck_beat(tempo);
    int bars = (int)lroundf(engine->deck_bar > 0.5f ? engine->deck_bar : 4.0f);
    if (bars < 1) bars = 1;
    if (beat < 1) beat = 1;
    engine->deck_view_span = bars * beat;
}

int deck_name(const char *s) {
    static const char *names[] = {
        "roll", "stut", "loop", "rev", "jump", "glch", "tran", "drop",
        "half", "dbl", "stop", "spin", "back", "scr", "hlx", "thrw"
    };
    static const char *groups[] = { "rpt", "lop", "glc", "scr", "gat", "pch", "stp", "thr" };
    if (s[0] == '-' && s[1] == 0) return -1;
    for (int i = 0; i < 16; i++) {
        if (strcmp(s, names[i]) == 0) return i;
    }
    if (s[0] && s[1] && s[2] && s[3] >= '0' && s[3] <= '3' && s[4] == 0) {
        char key[4] = { s[0], s[1], s[2], 0 };
        for (int g = 0; g < 8; g++) {
            if (strcmp(key, groups[g]) == 0) return 16 + g * 4 + (s[3] - '0');
        }
    }
    return -2;
}

void deck_apply_text(Engine *engine, const char *text) {
    if (!text || text[0] != 'D') return;
    char name[32];
    float k0, k1, k2, k3, k4, k5, k6, k7;
    float t0 = 0.5f, t1 = 0.0f, t2 = 0.0f, t3 = 0.5f, t4 = 0.5f, t5 = 0.5f;
    int warm = 0, seed = 0, bar = 4;
    int got = sscanf(text, "D|%31[^|]|%f,%f,%f,%f,%f,%f,%f,%f,%f,%f,%f,%f,%f,%f|%d|%d|%d",
            name, &k0, &k1, &k2, &k3, &k4, &k5, &k6, &k7, &t0, &t1, &t2, &t3, &t4, &t5, &warm, &seed, &bar);
    if (got != 18) {
        t0 = 0.5f;
        t1 = 0.0f;
        t2 = 0.0f;
        t3 = 0.5f;
        t4 = 0.5f;
        t5 = 0.5f;
        if (sscanf(text, "D|%31[^|]|%f,%f,%f,%f,%f,%f,%f,%f|%d|%d|%d",
                name, &k0, &k1, &k2, &k3, &k4, &k5, &k6, &k7, &warm, &seed, &bar) != 12) return;
    }
    char *serial_at = strchr(name, '#');
    int serial = 0;
    int gesture;
    if (serial_at) {
        *serial_at = 0;
        serial = atoi(serial_at + 1);
    }
    gesture = deck_name(name);
    if (gesture < -1) return;
    engine->deck_k[0] = k0;
    engine->deck_k[1] = k1;
    engine->deck_k[2] = k2;
    engine->deck_k[3] = k3;
    engine->deck_k[4] = k4;
    engine->deck_k[5] = k5;
    engine->deck_k[6] = k6;
    engine->deck_k[7] = k7;
    engine->deck_tone[0] = t0;
    engine->deck_tone[1] = t1;
    engine->deck_tone[2] = t2;
    engine->deck_tone[3] = t3;
    engine->deck_tone[4] = t4;
    engine->deck_tone[5] = t5;
    engine->deck_warm = warm ? 1 : 0;
    engine->deck_seed = seed;
    engine->deck_bar = bar > 1 ? (float)bar : 1.0f;
    if (gesture == engine->deck_command && serial == engine->deck_serial) return;
    engine->deck_command = gesture;
    engine->deck_serial = serial;
    if (gesture >= 0) {
        engine->deck_gesture = gesture;
        engine->deck_down = engine->clock;
        engine->deck_up = -1;
        return;
    }
    if (engine->deck_gesture >= 0 && engine->deck_up < 0) engine->deck_up = engine->clock;
}

float deck_tone_cascade(float *pole, float input, float coef) {
    pole[0] += (input - pole[0]) * coef;
    pole[1] += (pole[0] - pole[1]) * coef;
    return pole[1];
}

/* 0 kills, 0.5 is unity, 1 is +6 dB. Exactly 0.5 stays 1. */

float deck_iso_gain(float knob) {
    float x = knob;
    if (x < 0.0f) x = 0.0f;
    if (x > 1.0f) x = 1.0f;
    if (x == 0.5f) return 1.0f;
    if (x < 0.5f) return x * 2.0f;
    return 1.0f + (x - 0.5f) * 2.0f;
}

float deck_isolate(float *low_pole, float *high_pole, float input, float low, float mid, float high) {
    static float low_coef = 0.0f;
    static float high_coef = 0.0f;
    float low_band, high_split, g_l, g_m, g_h;
    if (low_coef == 0.0f) {
        low_coef = pole_coef(250.0f);
        high_coef = pole_coef(2500.0f);
    }
    low_band = deck_tone_cascade(low_pole, input, low_coef);
    high_split = deck_tone_cascade(high_pole, input, high_coef);
    g_l = deck_iso_gain(low);
    g_m = deck_iso_gain(mid);
    g_h = deck_iso_gain(high);
    if (g_l == 1.0f && g_m == 1.0f && g_h == 1.0f) return input;
    return low_band * g_l + (high_split - low_band) * g_m + (input - high_split) * g_h;
}

float deck_drive(float input, float drive) {
    float amount = drive;
    float gain, wet;
    if (amount < 0.0f) amount = 0.0f;
    if (amount > 1.0f) amount = 1.0f;
    if (amount < 1e-4f) return input;
    gain = 1.0f + amount * 8.0f;
    wet = tanhf(input * gain) / gain;
    return input * (1.0f - amount) + wet * amount;
}

/* Isolator, then the lane filter, then drive. The ring is already written. */

void deck_tone_color(Engine *engine, float *l, float *r) {
    float *t = engine->deck_tone;
    *l = deck_drive(filter_sample(&engine->tone_flt_l[0], &engine->tone_flt_l[1], &engine->tone_cache_l,
        deck_isolate(engine->tone_lo_l, engine->tone_hi_l, *l, t[3], t[4], t[5]), t[0], t[1]), t[2]);
    *r = deck_drive(filter_sample(&engine->tone_flt_r[0], &engine->tone_flt_r[1], &engine->tone_cache_r,
        deck_isolate(engine->tone_lo_r, engine->tone_hi_r, *r, t[3], t[4], t[5]), t[0], t[1]), t[2]);
}
