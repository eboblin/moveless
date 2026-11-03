#include "engine.h"

void push_lane(Engine *engine, int lane, int param, float value, int pattern, float cycle, float amount) {
    if (lane < 0 || lane >= LANE_COUNT || param == P_NONE || param == P_FREQ) return;
    LaneBox *box = &engine->lanes[lane];
    int live = amount != 0.0f;
    int *count = live ? &box->live_count : &box->still_count;
    if (*count >= LANE_MOTION_CAP) return;
    LaneMotion *slot = live ? &box->live[*count] : &box->still[*count];
    slot->param = param;
    slot->pattern = pattern;
    slot->value = value;
    slot->cycle = cycle;
    slot->amount = amount;
    (*count)++;
}

float smooth_gain(float t) {
    if (t < 0.0f) t = 0.0f;
    if (t > 1.0f) t = 1.0f;
    return t * t * (3.0f - 2.0f * t);
}

float handoff_gain(const Engine *engine, int lane, int sample) {
    for (int i = 0; i < engine->handoff_n; i++) {
        const Handoff *h = &engine->handoff[i];
        if (h->lane != lane) continue;
        int span = h->end - h->start;
        if (span <= 0) return h->kind == 2 ? 0.0f : 1.0f;
        if (sample <= h->start) return h->kind == 1 ? 0.0f : 1.0f;
        if (sample >= h->end) return h->kind == 2 ? 0.0f : 1.0f;
        if (h->kind == 1) return smooth_gain((float)(sample - h->start) / (float)span);
        if (h->kind == 2) return 1.0f - smooth_gain((float)(sample - h->start) / (float)span);
        if (sample <= h->commit) {
            int den = h->commit - h->start;
            return den > 0 ? 1.0f - smooth_gain((float)(sample - h->start) / (float)den) : 0.0f;
        }
        int den = h->end - h->commit;
        return den > 0 ? smooth_gain((float)(sample - h->commit) / (float)den) : 1.0f;
    }
    return 1.0f;
}

void apply_handoff(Engine *engine, char *text) {
    engine->handoff_n = 0;
    char *cursor = text;
    while (cursor && *cursor && engine->handoff_n < 8) {
        char *semi = strchr(cursor, ';');
        if (semi) *semi = 0;
        int lane = 0, start = 0, commit = 0, end = 0;
        char kind = 'd';
        if (sscanf(cursor, "%d,%c,%d,%d,%d", &lane, &kind, &start, &commit, &end) == 5) {
            Handoff *slot = &engine->handoff[engine->handoff_n++];
            slot->lane = lane;
            slot->kind = kind == 'i' ? 1 : kind == 'o' ? 2 : 0;
            slot->start = start;
            slot->commit = commit;
            slot->end = end;
        }
        cursor = semi ? semi + 1 : NULL;
    }
}

void ingest_phrase(Engine *engine) {
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
        /* The past strip reads peaks by absolute sample. A leftover filled
         * watermark sits past the new head, so the left half stays empty. */
        engine->deck_filled = 0;
        if (engine->deck_peak_l) memset(engine->deck_peak_l, 0, (size_t)DECK_PEAKS * sizeof(float));
        if (engine->deck_peak_r) memset(engine->deck_peak_r, 0, (size_t)DECK_PEAKS * sizeof(float));
        fx_clear(engine);
    }
    engine->phrase_on = 1;
    engine->phrase_count = 0;
    for (int lane = 0; lane < LANE_COUNT; lane++) {
        engine->lanes[lane].live_count = 0;
        engine->lanes[lane].still_count = 0;
    }
    char *cursor = body + 1;
    char *hand = strchr(cursor, '~');
    if (hand) {
        *hand = 0;
        apply_handoff(engine, hand + 1);
    } else {
        engine->handoff_n = 0;
    }
    char *bus = strchr(cursor, '^');
    if (bus) {
        *bus = 0;
        apply_bus(engine, bus + 1);
    } else {
        engine->glue = 0;
        engine->pump = 0;
        engine->wide = 0;
        engine->tilt = 0;
    }
    char *fx = strchr(cursor, '@');
    if (fx) {
        *fx = 0;
        apply_fx(engine, fx + 1);
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
            int lane = 0, pattern = 0, loop = 0;
            float value = 0, cycle = 0, amount = 0;
            char id[24];
            int fields = sscanf(motion, "%d:%23[^:]:%f:%d:%f:%f:%d",
                &lane, id, &value, &pattern, &cycle, &amount, &loop);
            if (fields == 7)
                push_lane(engine, lane, param_of(id), value, pattern, cycle, amount);
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
    bake_envelopes(engine);
}

unsigned phrase_timing_sig(const Engine *engine) {
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

void catch_holding(Engine *engine) {
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
