#include "engine.h"

int line_make(Line *line, int n) {
    line->buf = (float *)calloc((size_t)n, sizeof(float));
    line->n = line->buf ? n : 0;
    line->i = 0;
    return line->buf != NULL;
}

void line_free(Line *line) {
    free(line->buf);
    line->buf = NULL;
    line->n = 0;
    line->i = 0;
}

void line_clear(Line *line) {
    if (!line->buf || line->n < 1) return;
    memset(line->buf, 0, (size_t)line->n * sizeof(float));
    line->i = 0;
}

float line_read(const Line *line, float delay) {
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

void line_write(Line *line, float x) {
    if (x > -1e-15f && x < 1e-15f) x = 0.0f;
    line->buf[line->i] = x;
    if (++line->i >= line->n) line->i = 0;
}

float line_ap(Line *line, float delay, float x, float g) {
    float z = line_read(line, delay);
    float y = -g * x + z;
    line_write(line, x + g * y);
    return y;
}

float line_delay(Line *line, float samples, float x) {
    float y = line_read(line, samples);
    line_write(line, x);
    return y;
}

float paper_scale(void) { return SR / 29761.0f; }

int tank_len(float base) {
    return (int)ceilf(base * paper_scale() * 1.85f) + 32;
}

float sized_delay(float base, float scale) {
    return base * paper_scale() * scale;
}

/* Matches THROW_DELAY in src/core/deck.ts. Rows are SOFT, EVEN, TAIL, HOT. */

void throw_preset(Echo *e, int row) {
    static const float table[4][8] = {
        { 0.2f, 0.25f, 0.28f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f },
        { 0.6f, 0.5f, 0.5f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f },
        { 0.8f, 0.78f, 0.22f, 0.0f, 0.0f, 0.0f, 0.15f, 1.0f },
        { 0.4f, 0.55f, 0.78f, 0.0f, 1.0f, 0.7f, 0.0f, 1.0f },
    };
    const float *p;
    if (row < 0) row = 0;
    if (row > 3) row = 3;
    p = table[row];
    e->time = p[0];
    e->feed = p[1];
    e->tone = p[2];
    e->duck = p[3];
    e->ping = p[4];
    e->taps = p[5];
    e->wow = p[6];
    e->level = p[7];
}

int fx_init(Engine *engine) {
    Plate *p = &engine->plate;
    Echo *e = &engine->echo;
    float s = paper_scale();
    int ok = 1;
    ok = line_make(&p->preL, (int)ceilf(SR * 0.05f) + 8) && ok;
    ok = line_make(&p->preR, (int)ceilf(SR * 0.05f) + 8) && ok;
    ok = line_make(&p->earlyL, (int)ceilf(SR * 0.08f) + 8) && ok;
    ok = line_make(&p->earlyR, (int)ceilf(SR * 0.08f) + 8) && ok;
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
    ok = line_make(&p->shimLine, 2048 + 8) && ok;
    ok = line_make(&e->l, (int)ceilf(SR * 2.0f) + 8) && ok;
    ok = line_make(&e->r, (int)ceilf(SR * 2.0f) + 8) && ok;
    ok = line_make(&engine->throw_echo.l, (int)ceilf(SR * 2.0f) + 8) && ok;
    ok = line_make(&engine->throw_echo.r, (int)ceilf(SR * 2.0f) + 8) && ok;
    throw_preset(&engine->throw_echo, 0);
    p->size = 0.42f;
    p->decay = 0.42f;
    p->air = 0.5f;
    p->spin = 0.3f;
    p->shim = 0.0f;
    p->level = 0.6f;
    e->time = 0.4f;
    e->feed = 0.4f;
    e->tone = 0.5f;
    e->duck = 0.0f;
    e->ping = 0.0f;
    e->taps = 0.0f;
    e->wow = 0.0f;
    e->level = 0.7f;
    e->follow = 0.0f;
    engine->beats = 4.0f;
    engine->deck_mask = (1 << 18) - 1;
    engine->deck_l = calloc((size_t)(engine->deck_mask + 1), sizeof(float));
    engine->deck_r = calloc((size_t)(engine->deck_mask + 1), sizeof(float));
    if (!engine->deck_l || !engine->deck_r) return 0;
    engine->deck_gesture = -1;
    engine->deck_command = -1;
    engine->deck_serial = -1;
    engine->deck_up = -1;
    engine->deck_k[0] = 2.0f;
    engine->deck_k[1] = 0.5f;
    engine->deck_k[2] = 1.0f;
    engine->deck_k[3] = 4.0f;
    engine->deck_k[5] = 2.0f;
    engine->deck_k[6] = 0.5f;
    engine->deck_k[7] = 0.5f;
    engine->deck_tone[0] = 0.5f;
    engine->deck_tone[3] = 0.5f;
    engine->deck_tone[4] = 0.5f;
    engine->deck_tone[5] = 0.5f;
    engine->deck_bar = 4.0f;
    engine->deck_seed = 1;
    engine->deck_peak_l = calloc((size_t)DECK_PEAKS, sizeof(float));
    engine->deck_peak_r = calloc((size_t)DECK_PEAKS, sizeof(float));
    if (!engine->deck_peak_l || !engine->deck_peak_r) return 0;
    engine->deck_view_span = 4 * (int)lroundf((SR * 60.0f) / 120.0f);
    return ok;
}

void fx_free(Engine *engine) {
    free(engine->deck_l);
    free(engine->deck_r);
    free(engine->deck_peak_l);
    free(engine->deck_peak_r);
    engine->deck_l = NULL;
    engine->deck_peak_l = NULL;
    engine->deck_peak_r = NULL;
    engine->deck_r = NULL;
    Plate *p = &engine->plate;
    line_free(&p->preL);
    line_free(&p->preR);
    line_free(&p->earlyL);
    line_free(&p->earlyR);
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
    line_free(&p->shimLine);
    line_free(&engine->echo.l);
    line_free(&engine->echo.r);
    line_free(&engine->throw_echo.l);
    line_free(&engine->throw_echo.r);
}

void echo_clear(Echo *e) {
    line_clear(&e->l);
    line_clear(&e->r);
    e->lpL = 0;
    e->lpR = 0;
    e->phase = 0;
    e->hold = 0;
    e->follow = 0;
    e->quiet = 0;
}

void fx_clear(Engine *engine) {
    Plate *p = &engine->plate;
    line_clear(&p->preL);
    line_clear(&p->preR);
    line_clear(&p->earlyL);
    line_clear(&p->earlyR);
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
    line_clear(&p->shimLine);
    p->dampL = 0;
    p->dampR = 0;
    p->hpL = 0;
    p->hpR = 0;
    p->bw = 0;
    p->right = 0;
    p->lfo = 0;
    p->scale = 0;
    p->shimPhase = 0;
    p->shimLp = 0;
    p->quiet = 0;
    echo_clear(&engine->echo);
    echo_clear(&engine->throw_echo);
    bus_clear(engine);
}

void apply_fx(Engine *engine, const char *text) {
    float v[15];
    int n = 0;
    const char *cursor = text;
    while (n < 15 && cursor && *cursor) {
        char *end = NULL;
        float value = strtof(cursor, &end);
        if (end == cursor) break;
        v[n++] = value;
        cursor = (*end == ',') ? end + 1 : end;
    }
    if (n < 14) return;
    Plate *p = &engine->plate;
    Echo *e = &engine->echo;
    p->size = clampf01(v[0]);
    p->decay = clampf01(v[1]);
    p->air = clampf01(v[2]);
    p->spin = clampf01(v[3]);
    p->shim = clampf01(v[4]);
    p->level = clampf01(v[5]);
    e->time = clampf01(v[6]);
    e->feed = clampf01(v[7]);
    e->tone = clampf01(v[8]);
    e->duck = clampf01(v[9]);
    e->ping = clampf01(v[10]);
    e->taps = clampf01(v[11]);
    e->wow = clampf01(v[12]);
    e->level = clampf01(v[13]);
    if (n >= 15 && v[14] >= 1.0f) engine->beats = v[14];
}

float smooth_pole(float state, float x, float coef) {
    return state + (x - state) * coef;
}

float plate_hp(void) {
    static float coef = -1.0f;
    if (coef < 0.0f) coef = pole_coef(40.0f);
    return coef;
}

/** One gain per side. DECAY 0 is 0.4 s, DECAY 1 is 60 s. */

float decay_gain(float decay, float scale) {
    float seconds = 0.4f * powf(150.0f, clampf01(decay));
    float loop = (21589.0f / 29761.0f) * scale;
    float coef = expf((logf(0.001f) * loop) / (2.0f * seconds));
    return coef > 0.99f ? 0.99f : coef;
}

void air_hz(float air, float *bw, float *damp) {
    float u = clampf01(air);
    if (u < 0.5f) {
        *bw = 2000.0f * powf(6.0f, u / 0.5f);
        *damp = 2000.0f * powf(3.0f, u / 0.5f);
    } else {
        *bw = 12000.0f * powf(4.0f / 3.0f, (u - 0.5f) / 0.5f);
        *damp = 6000.0f * powf(5.0f / 3.0f, (u - 0.5f) / 0.5f);
    }
}

float follow_scale(float current, float target) {
    float slew = 0.25f / sized_delay(4453.0f, 1.0f);
    float d = target - current;
    if (d > slew) return current + slew;
    if (d < -slew) return current - slew;
    return target;
}

void spin_of(float spin, float scale, float *rate, float *excursion) {
    float u = clampf01(spin);
    float room = sized_delay(121.0f, scale) - 8.0f;
    if (room < 1.0f) room = 1.0f;
    *rate = 0.5f + u * 3.0f;
    *excursion = (u * 0.35f + u * u * 0.65f) * room;
}

float early_cluster(Line *line, float x, const float *sec, const float *gain, float scale) {
    float y = 0.0f;
    int i;
    for (i = 0; i < 4; i++) y += line_read(line, sec[i] * scale * SR) * gain[i];
    line_write(line, x);
    return y;
}

float raised(float t) {
    return 0.5f * (1.0f - cosf(TWO_PI * t));
}

float shim_pole(void) {
    static float coef = -1.0f;
    if (coef < 0.0f) coef = pole_coef(6000.0f);
    return coef;
}

/** Octave up, once per round trip. Amount 0 leaves the line unwritten. */

float shimmer(Plate *p, float x, float amount) {
    float n, phase, q, pitched;
    if (amount <= 0.0f) return x;
    n = 2048.0f;
    phase = p->shimPhase;
    if (phase >= n) phase -= n;
    q = phase >= 1024.0f ? phase - 1024.0f : phase + 1024.0f;
    pitched = line_read(&p->shimLine, n - phase) * raised(phase / n)
        + line_read(&p->shimLine, n - q) * raised(q / n);
    line_write(&p->shimLine, x);
    p->shimPhase = phase + 1.0f;
    p->shimLp = smooth_pole(p->shimLp, pitched, shim_pole());
    return x * (1.0f - amount) + p->shimLp * amount;
}

void plate_sample(Engine *engine, float inL, float inR, float *outL, float *outR) {
    static const float early_l_s[4] = { 0.0059f, 0.0112f, 0.0178f, 0.0294f };
    static const float early_l_g[4] = { 0.42f, -0.28f, 0.18f, -0.11f };
    static const float early_r_s[4] = { 0.0074f, 0.0131f, 0.0236f, 0.037f };
    static const float early_r_g[4] = { 0.40f, -0.26f, 0.16f, -0.10f };
    Plate *p = &engine->plate;
    float energy = fabsf(inL) + fabsf(inR);
    float target, u, scale, pre_samples, early_scale, pre_l, pre_r, early_l, early_r;
    float bw_hz, damp_hz, damp_coef, decay, rate, excursion, wobble, swirl, s;
    float x, left, body, left_end, right, taps_l, taps_r;
    target = 0.8f + clampf01(p->size) * 0.55f;
    if (p->scale == 0.0f) p->scale = target;
    else p->scale = follow_scale(p->scale, target);
    if (energy < 1e-7f && p->quiet > (int)(SR / 2.0f)) {
        *outL = 0;
        *outR = 0;
        return;
    }
    scale = p->scale;
    u = (scale - 0.8f) / 0.55f;
    pre_samples = (0.006f + u * 0.03f) * SR;
    early_scale = 0.7f + u * 0.6f;
    if (pre_samples < 1.0f) pre_samples = 1.0f;
    pre_l = line_delay(&p->preL, pre_samples, inL);
    pre_r = line_delay(&p->preR, pre_samples, inR);
    early_l = early_cluster(&p->earlyL, pre_l, early_l_s, early_l_g, early_scale);
    early_r = early_cluster(&p->earlyR, pre_r, early_r_s, early_r_g, early_scale);
    air_hz(p->air, &bw_hz, &damp_hz);
    p->bw = smooth_pole(p->bw, (pre_l + pre_r) * 0.5f, pole_coef(bw_hz));
    s = paper_scale();
    x = p->bw;
    x = line_ap(&p->in0, 142.0f * s, x, 0.75f);
    x = line_ap(&p->in1, 107.0f * s, x, 0.75f);
    x = line_ap(&p->in2, 379.0f * s, x, 0.625f);
    x = line_ap(&p->in3, 277.0f * s, x, 0.625f);
    decay = decay_gain(p->decay, scale);
    spin_of(p->spin, scale, &rate, &excursion);
    p->lfo += (TWO_PI * rate) / SR;
    if (p->lfo > TWO_PI) p->lfo -= TWO_PI;
    wobble = sinf(p->lfo) * excursion;
    swirl = cosf(p->lfo) * excursion;
    damp_coef = pole_coef(damp_hz);
    left = x + p->right * decay;
    left = line_ap(&p->modL, sized_delay(672.0f, scale) + wobble, left, 0.7f);
    body = line_delay(&p->dL1, sized_delay(4453.0f, scale) + wobble, left);
    p->dampL = smooth_pole(p->dampL, body, damp_coef);
    p->hpL = smooth_pole(p->hpL, p->dampL, plate_hp());
    body = p->dampL - p->hpL;
    left = line_ap(&p->apL, sized_delay(1800.0f, scale) + wobble, body, 0.5f);
    left_end = line_delay(&p->dL2, sized_delay(3720.0f, scale) + wobble, left);
    right = x + shimmer(p, left_end, p->shim * 0.75f) * decay;
    right = line_ap(&p->modR, sized_delay(908.0f, scale) + swirl, right, 0.7f);
    body = line_delay(&p->dR1, sized_delay(4217.0f, scale) + swirl, right);
    p->dampR = smooth_pole(p->dampR, body, damp_coef);
    p->hpR = smooth_pole(p->hpR, p->dampR, plate_hp());
    body = p->dampR - p->hpR;
    right = line_ap(&p->apR, sized_delay(2656.0f, scale) + swirl, body, 0.5f);
    p->right = line_delay(&p->dR2, sized_delay(3163.0f, scale) + swirl, right);
    taps_l = line_read(&p->dL1, sized_delay(266.0f, scale) + wobble)
        + line_read(&p->dL1, sized_delay(2974.0f, scale) + wobble)
        - line_read(&p->apL, sized_delay(1913.0f, scale) + wobble)
        + line_read(&p->dL2, sized_delay(1996.0f, scale) + wobble)
        - line_read(&p->dR1, sized_delay(1990.0f, scale) + swirl)
        - line_read(&p->apR, sized_delay(187.0f, scale) + swirl)
        - line_read(&p->dR2, sized_delay(1066.0f, scale) + swirl);
    taps_r = line_read(&p->dR1, sized_delay(353.0f, scale) + swirl)
        + line_read(&p->dR1, sized_delay(3627.0f, scale) + swirl)
        - line_read(&p->apR, sized_delay(1228.0f, scale) + swirl)
        + line_read(&p->dR2, sized_delay(2673.0f, scale) + swirl)
        - line_read(&p->dL1, sized_delay(2111.0f, scale) + wobble)
        - line_read(&p->apL, sized_delay(335.0f, scale) + wobble)
        - line_read(&p->dL2, sized_delay(121.0f, scale) + wobble);
    *outL = (early_l * 0.4f + taps_l * 0.15f) * p->level;
    *outR = (early_r * 0.4f + taps_r * 0.15f) * p->level;
    p->quiet = energy + fabsf(*outL) + fabsf(*outR) < 1e-6f ? p->quiet + 1 : 0;
}

float duck_release(void) {
    static float coef = -1.0f;
    if (coef < 0.0f) coef = expf(-1.0f / (0.9f * SR));
    return coef;
}

float tap_place(float main, float step, int k) {
    float min_gap = 0.012f * SR;
    float back;
    if (step * 0.4f > min_gap) min_gap = step * 0.4f;
    back = main - (float)k * step;
    if (back >= min_gap && main - back >= min_gap) return back;
    back = main + (float)k * step;
    if (back < 1.0f) back = 1.0f;
    return back;
}

float tap_gain(float taps, int index) {
    float u = clampf01(taps);
    float start = (float)index / 3.0f;
    float end = (float)(index + 1) / 3.0f;
    if (u <= start) return 0.0f;
    if (u >= end) return 1.0f;
    return (u - start) / (end - start);
}

/** Center is a wire. Left is a lowpass down to 400 Hz, right a highpass up to 2.5 kHz. */

float tone_sample(Echo *e, int right, float x) {
    float u = clampf01(e->tone);
    float *state = right ? &e->lpR : &e->lpL;
    float hz, y;
    int hp;
    if (u == 0.5f) {
        *state = x;
        return x;
    }
    hp = u > 0.5f;
    hz = hp ? 80.0f * powf(31.25f, (u - 0.5f) / 0.5f) : 400.0f * powf(35.0f, u / 0.5f);
    y = smooth_pole(*state, x, pole_coef(hz));
    *state = y;
    return hp ? x - y : y;
}

/* The read may move by only half a sample each sample, or the repeat clicks. */

float follow_delay(float current, float target) {
    float d = target - current;
    if (d > 0.5f) return current + 0.5f;
    if (d < -0.5f) return current - 0.5f;
    return target;
}

void echo_sample(Engine *engine, Echo *e, float inL, float inR, float *outL, float *outR) {
    float energy = fabsf(inL) + fabsf(inR);
    float bar, clock, seconds, base, wow, driftL, driftR, rate, depth, step;
    float timeL, timeR, delL, delR, bounce, mono, srcL, srcR, fbL, fbR, feed;
    float wetL, wetR, env, open;
    int i;
    /* Half a second of silence is not enough when the repeat is still on its way. */
    if (energy < 1e-7f && e->quiet > (int)(SR / 2.0f) && (float)e->quiet > e->follow) {
        e->hold = 0.0f;
        *outL = 0;
        *outR = 0;
        return;
    }
    bar = engine->beats > 1.0f ? engine->beats : 1.0f;
    clock = clampf01(e->time);
    seconds = 0.125f * powf(bar / 0.125f, clock) * 60.0f / (engine->tempo > 1.0f ? engine->tempo : 1.0f);
    if (seconds > 2.0f) seconds = 2.0f;
    if (seconds < 0.001f) seconds = 0.001f;
    base = seconds * SR;
    e->follow = e->follow <= 0.0f ? base : follow_delay(e->follow, base);
    wow = clampf01(e->wow);
    driftL = 0.0f;
    driftR = 0.0f;
    if (wow > 0.0f) {
        rate = 0.5f + wow * 2.5f;
        e->phase += (TWO_PI * rate) / SR;
        if (e->phase > TWO_PI) e->phase -= TWO_PI;
        depth = wow * 0.01f * SR;
        driftL = sinf(e->phase) * depth;
        driftR = cosf(e->phase) * depth;
    }
    timeL = e->follow + driftL;
    timeR = e->follow + driftR;
    if (timeL < 1.0f) timeL = 1.0f;
    if (timeR < 1.0f) timeR = 1.0f;
    step = (60.0f / (engine->tempo > 1.0f ? engine->tempo : 1.0f)) / 4.0f * SR;
    delL = line_read(&e->l, timeL);
    delR = line_read(&e->r, timeR);
    wetL = delL;
    wetR = delR;
    for (i = 0; i < 3; i++) {
        float g = tap_gain(e->taps, i);
        float dL, dR, tap;
        if (g <= 0.0f) continue;
        dL = tap_place(timeL, step, i + 1);
        dR = tap_place(timeR, step, i + 1);
        tap = (line_read(&e->l, dL) + line_read(&e->r, dR)) * 0.5f * g;
        if (i == 0) {
            wetL += tap * 0.65f;
            wetR += tap;
        } else if (i == 1) {
            wetL += tap;
            wetR += tap * 0.65f;
        } else {
            wetL += tap;
            wetR += tap;
        }
    }
    bounce = clampf01(e->ping);
    mono = (inL + inR) * 0.5f;
    srcL = inL * (1.0f - bounce) + mono * bounce;
    srcR = inR * (1.0f - bounce);
    fbL = delL * (1.0f - bounce) + delR * bounce;
    fbR = delR * (1.0f - bounce) + delL * bounce;
    feed = e->feed * 0.92f;
    line_write(&e->l, tone_sample(e, 0, srcL + fbL * feed));
    line_write(&e->r, tone_sample(e, 1, srcR + fbR * feed));
    {
        float hit = energy * 12.0f;
        if (hit > 1.0f) hit = 1.0f;
        if (hit > e->hold) e->hold = hit;
        else e->hold *= duck_release();
    }
    env = e->hold > 1.0f ? 1.0f : e->hold;
    open = (1.0f - clampf01(e->duck) * env) * e->level;
    *outL = wetL * open;
    *outR = wetR * open;
    e->quiet = energy + fabsf(*outL) + fabsf(*outR) < 1e-6f ? e->quiet + 1 : 0;
}
