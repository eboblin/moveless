#include "engine.h"

void pan_gains(float pos, float *gl, float *gr) {
    float x = pos;
    if (x < 0.0f) x = 0.0f;
    if (x > 1.0f) x = 1.0f;
    *gl = x <= 0.5f ? 1.0f : (1.0f - x) * 2.0f;
    *gr = x >= 0.5f ? 1.0f : x * 2.0f;
}

void open_hat(float *l, float *r, float pos, float wide) {
    float opened, pl, pr, ol, orr, mono;
    opened = 0.5f + (pos - 0.5f) * (1.0f + wide);
    if (opened < 0.0f) opened = 0.0f;
    if (opened > 1.0f) opened = 1.0f;
    pan_gains(pos, &pl, &pr);
    pan_gains(opened, &ol, &orr);
    if (pl > 1e-4f) mono = *l / pl;
    else if (pr > 1e-4f) mono = *r / pr;
    else mono = 0.0f;
    *l = mono * ol;
    *r = mono * orr;
}

void pan_chord(float *l, float *r, int pitch, int lo, int hi, float wide) {
    float t, pos, gl, gr, mid, side;
    t = hi > lo ? (float)(pitch - lo) / (float)(hi - lo) : 0.5f;
    pos = 0.5f + (t - 0.5f) * wide;
    if (pos < 0.0f) pos = 0.0f;
    if (pos > 1.0f) pos = 1.0f;
    pan_gains(pos, &gl, &gr);
    mid = (*l + *r) * 0.5f;
    side = (*l - *r) * 0.5f;
    *l = mid * gl + side;
    *r = mid * gr - side;
}

void haas(float *buf, int *index, float *l, float *r, float wide) {
    float mid, delayed;
    int delay, pos;
    mid = (*l + *r) * 0.5f;
    delay = (int)(wide * 0.012f * SR + 0.5f);
    if (delay < 1) delay = 1;
    if (delay >= HAAS_N) delay = HAAS_N - 1;
    pos = *index - delay;
    if (pos < 0) pos += HAAS_N;
    delayed = buf[pos];
    buf[*index] = mid;
    *index += 1;
    if (*index >= HAAS_N) *index = 0;
    *r = *r * (1.0f - wide) + delayed * wide;
}

void pump_pair(Engine *engine, int lane, float *l, float *r) {
    float g;
    if (engine->pump <= 0.0f || engine->pump_env <= 0.0f) return;
    if (lane != LANE_BASS && lane != LANE_CHORDS) return;
    g = 1.0f - engine->pump * engine->pump_env;
    *l *= g;
    *r *= g;
}

void decay_pump(Engine *engine) {
    float eighth;
    if (engine->pump_env <= 0.0f) return;
    eighth = (SR * 30.0f) / (engine->tempo > 1.0f ? engine->tempo : 1.0f);
    engine->pump_env -= 1.0f / eighth;
    if (engine->pump_env < 0.0f) engine->pump_env = 0.0f;
}

float tilt_coef(void) {
    static float coef = 0.0f;
    if (coef == 0.0f) coef = 1.0f - expf((-TWO_PI * 1000.0f) / SR);
    return coef;
}

void tilt_mix(Engine *engine, float *l, float *r) {
    float coef = tilt_coef();
    float tilt = engine->tilt;
    engine->tilt_l += (*l - engine->tilt_l) * coef;
    engine->tilt_r += (*r - engine->tilt_r) * coef;
    if (tilt == 0.0f) return;
    *l = *l + tilt * (*l - 2.0f * engine->tilt_l);
    *r = *r + tilt * (*r - 2.0f * engine->tilt_r);
}

float shave(float x, float glue) {
    float k = glue * 2.5f;
    return tanhf(x * (1.0f + k)) / (1.0f + k);
}

float glue_coef(int attack) {
    static float atk = 0.0f;
    static float rel = 0.0f;
    if (atk == 0.0f) {
        atk = 1.0f - expf(-1.0f / (0.015f * SR));
        rel = 1.0f - expf(-1.0f / (0.15f * SR));
    }
    return attack ? atk : rel;
}

void glue_mix(Engine *engine, float *l, float *r) {
    float glue = engine->glue;
    float level, threshold, ratio, target, makeup, gain;
    if (glue <= 0.0f) return;
    level = fabsf(*l) > fabsf(*r) ? fabsf(*l) : fabsf(*r);
    threshold = 1.0f - glue * 0.85f;
    ratio = 1.0f + glue * 3.0f;
    target = 1.0f;
    if (level > threshold && level > 1e-8f) target = (threshold + (level - threshold) / ratio) / level;
    engine->glue_gain += (target - engine->glue_gain) * glue_coef(target < engine->glue_gain);
    makeup = 1.0f + glue * 0.35f;
    gain = engine->glue_gain * makeup;
    *l = shave(*l * gain, glue);
    *r = shave(*r * gain, glue);
}

void bus_clear(Engine *engine) {
    int n;
    engine->pump_env = 0.0f;
    engine->glue_gain = 1.0f;
    engine->tilt_l = 0.0f;
    engine->tilt_r = 0.0f;
    for (n = 0; n < DRUMS; n++) {
        engine->drums[n].haas_i = 0;
        memset(engine->drums[n].haas, 0, sizeof engine->drums[n].haas);
    }
    for (n = 0; n < NOTES; n++) {
        engine->notes[n].haas_i = 0;
        memset(engine->notes[n].haas, 0, sizeof engine->notes[n].haas);
    }
}

void apply_bus(Engine *engine, const char *text) {
    float g = 0, p = 0, w = 0, t = 0;
    if (!text || sscanf(text, "%f,%f,%f,%f", &g, &p, &w, &t) < 4) return;
    engine->glue = clampf01(g);
    engine->pump = clampf01(p);
    engine->wide = clampf01(w);
    if (t < -1.0f) t = -1.0f;
    if (t > 1.0f) t = 1.0f;
    engine->tilt = t;
}

int fire_cmp(const void *a, const void *b) {
    const Fire *fa = (const Fire *)a;
    const Fire *fb = (const Fire *)b;
    return fa->offset - fb->offset;
}

/* Full-velocity peak of each lane. Same shelf the TypeScript follower divides by. */
static const float DUCK_FULL[7] = { 0.85f, 0.55f, 0.6f, 0.6f, 0.22f, 0.22f, 0.22f };

static float duck_hold(void) {
    static float k = -1.0f;
    if (k < 0.0f) k = expf(-1.0f / (0.03f * SR));
    return k;
}

static float follow_heard(float env, float peak) {
    float next = peak >= env ? peak : peak + (env - peak) * duck_hold();
    return next < 1e-8f ? 0.0f : next;
}

static float duck_scale(float value, float env, float amount) {
    float rest = value < 0 ? 0 : value > 1 ? 1 : value;
    float heard = rest + env * amount * 3.0f;
    if (heard < 0) heard = 0;
    if (heard > 1) heard = 1;
    if (rest < 1e-4f) return 1.0f;
    return heard / rest;
}

static float lane_duck(const Engine *engine, int lane) {
    int n = engine->duck_n[lane];
    float scale = 1.0f;
    for (int i = 0; i < n; i++) {
        int source = engine->duck_source[lane][i];
        float env = source == lane ? engine->dry_env[source] : engine->wet_env[source];
        float unit = env / DUCK_FULL[source];
        if (unit < 0) unit = 0;
        if (unit > 1) unit = 1;
        scale *= duck_scale(engine->duck_value[lane][i], unit, engine->duck_amount[lane][i]);
    }
    return scale;
}

void render(Engine *engine, int16_t *out, int frames) {
#if defined(__aarch64__)
    /* Denormals stall this core. A fade or a duck sits on that edge for the whole transition. */
    {
        uint64_t fpcr;
        __asm__ volatile("mrs %0, fpcr" : "=r"(fpcr));
        fpcr |= 1ull << 24;
        __asm__ volatile("msr fpcr, %0" :: "r"(fpcr));
    }
#endif
    ensure_wave_table();
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
    float block_peak[METER_N];
    int hot = 0;
    for (int m = 0; m < METER_N; m++) block_peak[m] = 0.0f;
    for (int lane = 0; lane < 7; lane++) if (engine->duck_n[lane]) hot = 1;
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
        float wide = engine->wide;
        int chord_lo = 128, chord_hi = -1;
        if (wide > 0.0f) {
            for (int n = 0; n < NOTES; n++) {
                if (!engine->notes[n].on || engine->notes[n].lane != LANE_CHORDS) continue;
                if (engine->notes[n].pitch < chord_lo) chord_lo = engine->notes[n].pitch;
                if (engine->notes[n].pitch > chord_hi) chord_hi = engine->notes[n].pitch;
            }
        }
        float left = 0, right = 0, revL = 0, revR = 0, dlyL = 0, dlyR = 0;
        float lane_l[7], lane_r[7];
        float dry_l[7] = {0}, dry_r[7] = {0}, duck_scale[7] = {1, 1, 1, 1, 1, 1, 1}, lane_gain[8] = {0};
        for (int lane = 0; lane < 7; lane++) {
            lane_l[lane] = 0.0f;
            lane_r[lane] = 0.0f;
        }
        /* One duck gain per lane. Voices only multiply; the follower runs after the mix. */
        if (hot) {
            for (int lane = 0; lane < 7; lane++) {
                dry_l[lane] = 0.0f;
                dry_r[lane] = 0.0f;
                duck_scale[lane] = lane_duck(engine, lane);
            }
        }
        if (engine->handoff_n) {
            for (int lane = 0; lane < 8; lane++) lane_gain[lane] = handoff_gain(engine, lane, engine->clock);
        }
        for (int d = 0; d < DRUMS; d++) {
            if (!engine->drums[d].on) continue;
            float l = 0, r = 0;
            int dlane = engine->drums[d].lane;
            float g = engine->handoff_n && dlane >= 0 && dlane < 8 ? lane_gain[dlane] : 1.0f;
            drum_sample(engine, &engine->drums[d], &l, &r);
            l *= g;
            r *= g;
            if (wide > 0.0f && dlane == LANE_HAT) open_hat(&l, &r, engine->drums[d].pos, wide);
            else if (wide > 0.0f && dlane == LANE_PERC) haas(engine->drums[d].haas, &engine->drums[d].haas_i, &l, &r, wide);
            if (hot && dlane >= 0 && dlane < 7) {
                dry_l[dlane] += l;
                dry_r[dlane] += r;
                l *= duck_scale[dlane];
                r *= duck_scale[dlane];
            }
            left += l;
            right += r;
            if (dlane >= 0 && dlane < 7) {
                lane_l[dlane] += l;
                lane_r[dlane] += r;
            }
            revL += l * engine->drums[d].reverb;
            revR += r * engine->drums[d].reverb;
            dlyL += l * engine->drums[d].delay;
            dlyR += r * engine->drums[d].delay;
        }
        for (int n = 0; n < NOTES; n++) {
            if (!engine->notes[n].on) continue;
            float nl = 0, nr = 0;
            int nlane = engine->notes[n].lane;
            float g = engine->handoff_n && nlane >= 0 && nlane < 8 ? lane_gain[nlane] : 1.0f;
            note_sample(engine, &engine->notes[n], &nl, &nr);
            nl *= g;
            nr *= g;
            if (wide > 0.0f && nlane == LANE_CHORDS) pan_chord(&nl, &nr, engine->notes[n].pitch, chord_lo, chord_hi, wide);
            else if (wide > 0.0f && nlane == LANE_LEAD) haas(engine->notes[n].haas, &engine->notes[n].haas_i, &nl, &nr, wide);
            if (hot && nlane >= 0 && nlane < 7) {
                dry_l[nlane] += nl;
                dry_r[nlane] += nr;
                nl *= duck_scale[nlane];
                nr *= duck_scale[nlane];
            }
            pump_pair(engine, nlane, &nl, &nr);
            left += nl;
            right += nr;
            if (nlane >= 0 && nlane < 7) {
                lane_l[nlane] += nl;
                lane_r[nlane] += nr;
            }
            revL += nl * engine->notes[n].reverb;
            revR += nr * engine->notes[n].reverb;
            dlyL += nl * engine->notes[n].delay;
            dlyR += nr * engine->notes[n].delay;
        }
        for (int lane = 0; lane < 7; lane++) {
            float a = fabsf(lane_l[lane]);
            float b = fabsf(lane_r[lane]);
            float p = a > b ? a : b;
            if (p > block_peak[lane]) block_peak[lane] = p;
            if (hot) {
                float dry = fabsf(dry_l[lane]) > fabsf(dry_r[lane]) ? fabsf(dry_l[lane]) : fabsf(dry_r[lane]);
                engine->dry_env[lane] = follow_heard(engine->dry_env[lane], dry);
                engine->wet_env[lane] = follow_heard(engine->wet_env[lane], p);
            }
        }
        float wetL = 0, wetR = 0, delL = 0, delR = 0, thrL = 0, thrR = 0;
        {
            int row = throw_row(engine->deck_gesture);
            float send = 0.0f;
            float depth = engine->deck_k[2];
            if (row >= 0) throw_preset(&engine->throw_echo, row);
            if (engine->deck_warm) send = deck_throw(engine);
            echo_sample(engine, &engine->throw_echo, left * send, right * send, &thrL, &thrR);
            if (!engine->deck_warm) depth = 0.0f;
            if (depth < 0.0f) depth = 0.0f;
            if (depth > 1.0f) depth = 1.0f;
            thrL *= depth;
            thrR *= depth;
        }
        plate_sample(engine, revL, revR, &wetL, &wetR);
        echo_sample(engine, &engine->echo, dlyL, dlyR, &delL, &delR);
        {
            float g = engine->handoff_n ? lane_gain[7] : 1.0f;
            wetL *= g;
            wetR *= g;
            delL *= g;
            delR *= g;
        }
        float l = left + wetL + delL + thrL;
        float r = right + wetR + delR + thrR;
        tilt_mix(engine, &l, &r);
        glue_mix(engine, &l, &r);
        if (engine->phrase_on) deck_hear(engine, &l, &r);
        deck_tone_color(engine, &l, &r);
        l = soft(l);
        r = soft(r);
        {
            float a = fabsf(l);
            float b = fabsf(r);
            float p = a > b ? a : b;
            if (p > block_peak[METER_MASTER]) block_peak[METER_MASTER] = p;
        }
        decay_pump(engine);
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
    follow_meters(engine, block_peak, frames);
    deck_capture_view(engine);
}

/** Instant attack, 150 ms release. The peak waits 700 ms, then falls the same way. */

void follow_meters(Engine *engine, const float *block, int frames) {
    if (!engine || !block || frames <= 0) return;
    float decay = expf(-(float)frames / (METER_RELEASE_SEC * SR));
    float hold = METER_HOLD_SEC * SR;
    for (int i = 0; i < METER_N; i++) {
        float peak = block[i];
        float level = engine->meter_level[i];
        engine->meter_level[i] = peak >= level ? peak : peak + (level - peak) * decay;
        if (peak >= engine->meter_peak[i]) {
            engine->meter_peak[i] = peak;
            engine->meter_hold[i] = hold;
        } else {
            engine->meter_hold[i] -= (float)frames;
            if (engine->meter_hold[i] <= 0.0f) engine->meter_peak[i] = peak + (engine->meter_peak[i] - peak) * decay;
        }
        if (engine->meter_level[i] < 1e-8f) engine->meter_level[i] = 0.0f;
        if (engine->meter_peak[i] < 1e-8f) engine->meter_peak[i] = 0.0f;
    }
}

int meter_byte(float peak) {
    if (peak < 0.0f) peak = 0.0f;
    if (peak > 1.0f) peak = 1.0f;
    peak = sqrtf(peak);
    int n = (int)lroundf(peak * 255.0f);
    if (n < 0) n = 0;
    if (n > 255) n = 255;
    return n;
}

int meter_key(const char *key) {
    if (!key) return 0;
    const char *colon = strrchr(key, ':');
    const char *name = colon ? colon + 1 : key;
    return strcmp(name, "meters") == 0;
}

/** Eight channels, level byte then peak byte, as 32 hex digits. */

int meter_page(const Engine *engine, char *buf, int buf_len) {
    static const char hex[] = "0123456789abcdef";
    if (!engine || !buf || buf_len < METER_N * 4 + 1) return -1;
    for (int i = 0; i < METER_N; i++) {
        int level = meter_byte(engine->meter_level[i]);
        int peak = meter_byte(engine->meter_peak[i]);
        buf[i * 4] = hex[level >> 4];
        buf[i * 4 + 1] = hex[level & 15];
        buf[i * 4 + 2] = hex[peak >> 4];
        buf[i * 4 + 3] = hex[peak & 15];
    }
    buf[METER_N * 4] = 0;
    return METER_N * 4;
}

int wave_key(const char *key) {
    if (!key) return -1;
    const char *colon = strrchr(key, ':');
    const char *name = colon ? colon + 1 : key;
    if (strcmp(name, "wave0") == 0) return 0;
    if (strcmp(name, "wave1") == 0) return 1;
    return -1;
}

void wave_column(const Engine *engine, float from, float to, float *pl, float *pr) {
    *pl = 0.0f;
    *pr = 0.0f;
    if (!engine->deck_peak_l || !engine->deck_peak_r) return;
    int filled = engine->deck_filled;
    int oldest = filled - (engine->deck_mask + 1);
    if (oldest < 0) oldest = 0;
    int s = (int)floorf(from);
    int end = (int)ceilf(to);
    if (s < oldest) s = oldest;
    if (end > filled) end = filled;
    while (s < end) {
        int hop = (s >> 7) & (DECK_PEAKS - 1);
        if (engine->deck_peak_l[hop] > *pl) *pl = engine->deck_peak_l[hop];
        if (engine->deck_peak_r[hop] > *pr) *pr = engine->deck_peak_r[hop];
        int next = (s & ~(DECK_HOP - 1)) + DECK_HOP;
        s = next > s ? next : s + 1;
    }
}

char wave_nibble(float peak) {
    if (peak < 0.0f) peak = 0.0f;
    if (peak > 1.0f) peak = 1.0f;
    int n = (int)lroundf(peak * 15.0f);
    if (n < 0) n = 0;
    if (n > 15) n = 15;
    return "0123456789abcdef"[n];
}

/** One page of the left half: `page|head|span|` and 32 stereo nibbles. */

int wave_page(const Engine *engine, int page, char *buf, int buf_len) {
    if (!buf || page < 0 || page > 1) return -1;
    int head = engine->deck_view_head;
    int span = engine->deck_view_span > 0 ? engine->deck_view_span : 1;
    char prefix[48];
    int n = snprintf(prefix, sizeof prefix, "%d|%d|%d|", page, head, span);
    if (n < 0 || n >= (int)sizeof prefix) return -1;
    if (buf_len < n + WAVE_PAGE * 2 + 1) return -1;
    memcpy(buf, prefix, (size_t)n);
    float start = (float)head - (float)span / 2.0f;
    float col = ((float)span / 2.0f) / (float)WAVE_COLS;
    for (int i = 0; i < WAVE_PAGE; i++) {
        int index = page * WAVE_PAGE + i;
        float from = start + (float)index * col;
        float pl = 0.0f;
        float pr = 0.0f;
        wave_column(engine, from, from + col, &pl, &pr);
        buf[n + i * 2] = wave_nibble(pl);
        buf[n + i * 2 + 1] = wave_nibble(pr);
    }
    buf[n + WAVE_PAGE * 2] = 0;
    return n + WAVE_PAGE * 2;
}
