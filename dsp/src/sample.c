#include "engine.h"

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

_Static_assert(sizeof(SampleZone) == 36, "sample zone size");
_Static_assert(sizeof(SampleSlot) == 8, "sample slot size");

static uint32_t ru32(const uint8_t *p) {
    uint32_t value;
    memcpy(&value, p, 4);
    return value;
}

void samples_free(Engine *engine) {
    if (!engine) return;
    if (engine->samples.map) munmap(engine->samples.map, engine->samples.map_len);
    memset(&engine->samples, 0, sizeof engine->samples);
}

void samples_load(Engine *engine, const char *module_dir) {
    char path[1024];
    int fd, wrote;
    struct stat st;
    void *map;
    const uint8_t *bytes;
    uint32_t version, slots, zones, frames, need;
    int i, start;
    if (!engine) return;
    samples_free(engine);
    if (!module_dir || !module_dir[0]) return;
    wrote = snprintf(path, sizeof path, "%s/samples.bin", module_dir);
    if (wrote < 0 || wrote >= (int)sizeof path) return;
    fd = open(path, O_RDONLY);
    if (fd < 0) return;
    if (fstat(fd, &st) != 0 || st.st_size < 40) {
        close(fd);
        return;
    }
    map = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (map == MAP_FAILED) return;
    bytes = map;
    version = ru32(bytes + 4);
    slots = ru32(bytes + 8);
    zones = ru32(bytes + 12);
    frames = ru32(bytes + 16);
    need = 40u + slots * 8u + zones * 36u + frames * 2u;
    if (memcmp(bytes, "MVLS", 4) != 0 || version != 1 || (uint64_t)st.st_size < need) {
        munmap(map, (size_t)st.st_size);
        return;
    }
    engine->samples.map = map;
    engine->samples.map_len = (size_t)st.st_size;
    engine->samples.slot_count = (int)slots;
    engine->samples.zone_count = (int)zones;
    engine->samples.pcm_frames = (int)frames;
    start = 0;
    for (i = 0; i < 5; i++) {
        engine->samples.catalog_count[i] = (int)ru32(bytes + 20 + (size_t)i * 4);
        engine->samples.catalog_start[i] = start;
        start += engine->samples.catalog_count[i];
    }
    engine->samples.slots = (SampleSlot *)(bytes + 40);
    engine->samples.zones = (SampleZone *)(bytes + 40 + slots * 8u);
    engine->samples.pcm = (const int16_t *)(bytes + 40 + slots * 8u + zones * 36u);
    bank_publish(&engine->samples);
}

static int sample_index(float unit, int count) {
    float u = clampf01(unit);
    int index;
    if (count < 1) return 0;
    index = (int)lroundf(u * (float)count);
    if (index < 0) index = 0;
    if (index > count) index = count;
    return index;
}

int sample_zone_for(const SampleBank *bank, int slot, int midi) {
    SampleSlot *entry;
    int nearest, best, i;
    if (!bank_is_ready(bank) || slot < 0 || slot >= bank->slot_count) return -1;
    entry = &bank->slots[slot];
    if (entry->zone_count < 1) return -1;
    nearest = (int)entry->zone_index;
    best = 100000;
    for (i = 0; i < (int)entry->zone_count; i++) {
        int zone = (int)entry->zone_index + i;
        int mid, dist;
        SampleZone *row;
        if (zone < 0 || zone >= bank->zone_count) continue;
        row = &bank->zones[zone];
        if ((int)row->key_lo <= midi && (int)row->key_hi + 1 >= midi) return zone;
        mid = ((int)row->key_lo + (int)row->key_hi) / 2;
        dist = mid - midi;
        if (dist < 0) dist = -dist;
        if (dist < best) {
            best = dist;
            nearest = zone;
        }
    }
    return nearest;
}

float sample_take(const SampleBank *bank, int zone, float *pos, float inc) {
    SampleZone *row;
    float p, next, frac, a, b;
    int i;
    if (!bank_is_ready(bank) || !pos || zone < 0 || zone >= bank->zone_count) return 0;
    row = &bank->zones[zone];
    p = *pos;
    next = p + inc;
    if (row->has_loop && row->loop_end > row->loop_start) {
        float start = (float)row->loop_start;
        float end = (float)row->loop_end;
        float span = end - start;
        if (span > 0.0f && next >= end) next = start + fmodf(next - start, span);
    } else if (next > (float)row->length) next = (float)row->length;
    *pos = next;
    if (p < 0.0f || p >= (float)row->length) return 0;
    i = (int)p;
    frac = p - (float)i;
    a = bank->pcm[row->offset + (uint32_t)i] / 32768.0f;
    b = a;
    if (i + 1 < (int)row->length) b = bank->pcm[row->offset + (uint32_t)i + 1] / 32768.0f;
    return a + (b - a) * frac;
}

void arm_sample_drum(Engine *engine, Drum *drum, const char *params, float pitch) {
    SampleBank *bank;
    int cat, index, slot, zone;
    float semis, ratio, sr;
    drum->sample_on = 0;
    drum->sample_pos = 0;
    drum->sample_inc = 0;
    bank = &engine->samples;
    if (!bank_is_ready(bank)) return;
    cat = drum->lane < 4 ? drum->lane : 4;
    index = sample_index(read_param(params, "sample", 0.0f), bank->catalog_count[cat]);
    if (index <= 0) return;
    slot = bank->catalog_start[cat] + index - 1;
    zone = sample_zone_for(bank, slot, 60);
    if (zone < 0) return;
    semis = (clampf01(pitch) - 0.5f) * 24.0f;
    ratio = powf(2.0f, semis / 12.0f);
    sr = bank->zones[zone].sample_rate > 1.0f ? bank->zones[zone].sample_rate : SR;
    drum->sample_on = 1;
    drum->sample_zone = zone;
    drum->sample_inc = ratio * sr / SR;
}

void arm_sample_note(Engine *engine, Note *note, const char *params, int midi, int legato) {
    SampleBank *bank = &engine->samples;
    int index, slot, zone, same;
    float base, ratio, remembered;
    if (!bank_is_ready(bank)) {
        note->sample_on = 0;
        return;
    }
    index = sample_index(read_param(params, "sample", 0.0f), bank->catalog_count[4]);
    if (index <= 0) {
        note->sample_on = 0;
        return;
    }
    slot = bank->catalog_start[4] + index - 1;
    zone = sample_zone_for(bank, slot, midi);
    if (zone < 0) {
        note->sample_on = 0;
        return;
    }
    base = bank->zones[zone].original_pitch - 100.0f * bank->zones[zone].coarse_tune - bank->zones[zone].fine_tune;
    ratio = powf(2.0f, (100.0f * (float)midi - base) / 1200.0f);
    same = legato && note->sample_on && note->sample_zone == zone;
    note->sample_target = ratio;
    if (!same) {
        note->sample_pos[0] = 0;
        note->sample_pos[1] = 0;
        note->sample_pos[2] = 0;
        remembered = note->lane >= 0 && note->lane < LANE_COUNT ? engine->lane_sample_rate[note->lane] : 0;
        note->sample_rate = note->glide > 1e-4f && remembered > 0 ? remembered : ratio;
    }
    note->sample_on = 1;
    note->sample_zone = zone;
}
