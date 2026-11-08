#include "engine.h"

void *create_instance(const char *module_dir, const char *json_defaults) {
    (void)json_defaults;
    Engine *engine = calloc(1, sizeof(Engine));
    if (!engine) return NULL;
    engine->phrase_text = calloc(1, PHRASE_TEXT);
    if (!engine->phrase_text) {
        free(engine);
        return NULL;
    }
    engine->noise = 1;
    engine->arm_clock = -1;
    engine->tempo = 120.0f;
    engine->beats = 4.0f;
    engine->glue_gain = 1.0f;
    ensure_wave_table();
    samples_boot(engine, module_dir);
    if (!fx_init(engine)) {
        samples_free(engine);
        fx_free(engine);
        free(engine->phrase_text);
        free(engine);
        return NULL;
    }
    return engine;
}

void set_param(void *instance, const char *key, const char *val) {
    Engine *engine = instance;
    if (!key || !val) return;
    if (strcmp(key, "block") != 0 && strcmp(key, "overtake_dsp:block") != 0) return;
    if (val[0] == 'D') {
        deck_apply_text(engine, val);
        return;
    }
    /* Keepalive. The phrase already playing stays; do not parse or replace it. */
    if (val[0] == 'K') return;
    if (val[0] == 'P' || val[0] == 'S') {
        snprintf(engine->phrase_text, PHRASE_TEXT, "%s", val);
        engine->phrase_pending = 1;
        return;
    }
    snprintf(engine->block, TEXT_CAP, "%s", val);
    engine->has_block = 1;
}

#ifndef MOVELESS_TEST

void destroy_instance(void *instance) {
    Engine *engine = instance;
    if (!engine) return;
    samples_stop(engine);
    samples_free(engine);
    fx_free(engine);
    free(engine->phrase_text);
    free(engine);
}

void on_midi(void *instance, const uint8_t *msg, int len, int source) {
    (void)instance;
    (void)msg;
    (void)len;
    (void)source;
}

/* Slack after the SPI transfer, per 128-frame block. The sample period is
 * ~2902 us; the transfer takes ~389 us and the measured remainder the
 * callback may spend is ~2370 us. 99 means this render filled that slack.
 * cpu_avg is that share in 1/256 percent. Dividing the error by 256 each
 * block is about a 0.7 s glide, so a single heavy block does not twitch
 * the line. */

int64_t mono_ns(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
    return (int64_t)ts.tv_sec * 1000000000LL + (int64_t)ts.tv_nsec;
}

void account_cpu(Engine *engine, int64_t spent_ns, int frames) {
    if (!engine || frames <= 0) return;
    int64_t budget = CPU_SLACK_NS_128 * (int64_t)frames / 128;
    if (budget <= 0) return;
    if (spent_ns < 0) spent_ns = 0;
    int pct = (int)((spent_ns * 100 + budget / 2) / budget);
    if (pct < 0) pct = 0;
    if (pct > 99) pct = 99;
    int sample = pct << 8;
    engine->cpu_avg += (sample - engine->cpu_avg) >> CPU_SMOOTH_SHIFT;
    int shown = (engine->cpu_avg + 128) >> 8;
    if (shown < 0) shown = 0;
    if (shown > 99) shown = 99;
    engine->cpu_pct = shown;
}

int cpu_key(const char *key) {
    if (!key) return 0;
    const char *colon = strrchr(key, ':');
    return strcmp(colon ? colon + 1 : key, "cpu") == 0;
}

static int bank_key(const char *key) {
    const char *colon;
    if (!key) return 0;
    colon = strrchr(key, ':');
    return strcmp(colon ? colon + 1 : key, "bank") == 0;
}

int get_param(void *instance, const char *key, char *buf, int buf_len) {
    Engine *engine = instance;
    if (!engine || !buf || buf_len < 1) return -1;
    int page = wave_key(key);
    if (page >= 0) return wave_page(engine, page, buf, buf_len);
    if (meter_key(key)) return meter_page(engine, buf, buf_len);
    if (bank_key(key)) return samples_bank_text(engine, buf, buf_len);
    if (!cpu_key(key) || buf_len < 3) return -1;
    int pct = engine->cpu_pct;
    if (pct < 0) pct = 0;
    if (pct > 99) pct = 99;
    buf[0] = (char)('0' + pct / 10);
    buf[1] = (char)('0' + pct % 10);
    buf[2] = 0;
    return 2;
}

int get_error(void *instance, char *buf, int buf_len) {
    (void)instance;
    if (buf && buf_len > 0) buf[0] = 0;
    return 0;
}

void render_block(void *instance, int16_t *out, int frames) {
    int64_t t0 = mono_ns();
    render(instance, out, frames);
    account_cpu(instance, mono_ns() - t0, frames);
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

#ifdef MOVELESS_TEST

int fail(const char *message) {
    fprintf(stderr, "%s\n", message);
    return 1;
}

int main(void) {
    Engine *engine = create_instance(NULL, NULL);
    int16_t out[256];
    long hat_center = 0, hat_left = 0, left_e = 0, right_e = 0;
    set_param(engine, "block", "120|0:2:42:100:48:v07_pos=0.5000,v07_decay=0.5000,v07_metal=0.9000,v07_noise=0.2000");
    render(engine, out, 128);
    for (int i = 0; i < 128; i++) {
        int d = out[i * 2] - out[i * 2 + 1];
        hat_center += d < 0 ? -d : d;
    }
    engine = create_instance(NULL, NULL);
    set_param(engine, "block", "120|0:2:42:100:48:v07_pos=0.0000,v07_decay=0.5000,v07_metal=0.9000,v07_noise=0.2000");
    render(engine, out, 128);
    for (int i = 0; i < 128; i++) {
        int d = out[i * 2] - out[i * 2 + 1];
        int l = out[i * 2] < 0 ? -out[i * 2] : out[i * 2];
        int r = out[i * 2 + 1] < 0 ? -out[i * 2 + 1] : out[i * 2 + 1];
        hat_left += d < 0 ? -d : d;
        left_e += l;
        right_e += r;
    }
    if (hat_left < hat_center * 2 || hat_left < 30 || left_e <= right_e) return fail("hat pos did not sit on the left");

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
    set_param(engine, "block", "P|120|1|0:300:0:36:120:48:v01_decay=0.0500");
    render(engine, out, 128);
    int age_first = engine->drums[0].age;
    render(engine, out, 128);
    int age_mid = engine->drums[0].age;
    render(engine, out, 128);
    if (!(age_mid > age_first && engine->drums[0].age < age_mid)) return fail("phrase did not loop on the audio clock");

    engine = create_instance(NULL, NULL);
    set_param(engine, "block", "120|0:0:36:120:48:v01_freq=0.4000,v01_decay=0.7000,v01_dist=0.5000");
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
    set_param(engine, "block", "P|120|1|0:44104:0:36:120:48:v01_freq=0.2000,v01_decay=0.7000#0:v01_freq:0.2000:0:8:1.0000:44104");
    render(engine, out, 128);
    float held_freq = engine->drums[0].freq;
    for (int n = 0; n < 86; n++) render(engine, out, 128);
    if (engine->drums[0].freq != held_freq) return fail("pitch followed the generator");

    engine = create_instance(NULL, NULL);
    set_param(engine, "block", "P|120|1|0:30000:6:48:110:400:wave=0.0000;0:30000:6:72:30:400:wave=0.0000^0.0000,0.0000,1.0000,0.0000");
    long bus_left = 0, bus_right = 0;
    for (int n = 0; n < 30; n++) {
        render(engine, out, 128);
        for (int i = 0; i < 128; i++) {
            int l = out[i * 2] < 0 ? -out[i * 2] : out[i * 2];
            int r = out[i * 2 + 1] < 0 ? -out[i * 2 + 1] : out[i * 2 + 1];
            bus_left += l;
            bus_right += r;
        }
    }
    if (bus_left <= bus_right) return fail("bus wide did not put the low chord tone on the left");

    printf("ok peak=%d hat=%ld width=%ld\n", peak, hat_left, diff_wide);
    return 0;
}

#endif
