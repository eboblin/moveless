/* Shared voice state. The plugin exports only move_plugin_init_v2. */
#ifndef MOVELESS_ENGINE_H
#define MOVELESS_ENGINE_H

/*
 * moveless voice. One drum voice per lane and one shared note pool for
 * bass, lead and chords. Parameter ids match src/dsp/map.ts.
 * Own synth — libpo32 / Surge are not vendored; keys stay compatible with map.ts.
 * Melody is a unison wavetable (frame, detune around the pitch, phase per voice).
 */

#define _POSIX_C_SOURCE 200809L

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define SR 44100.0f
#define DECK_HOP 128
#define DECK_PEAKS 2048
#define WAVE_COLS 64
#define WAVE_PAGE 32
#define TWO_PI 6.28318530718f
#define DRUMS 4
#define NOTES 12
#define TEXT_CAP 8192
#define PHRASE_TEXT 65536
#define PHRASE_CAP 512
#define LANE_COUNT 8
#define ENV_LANES 7
#define ENV_HOP 128
#define ENV_CAP 8192
#define LANE_MOTION_CAP 12
#define HAAS_N 544
#define LANE_HAT 2
#define LANE_PERC 3
#define LANE_BASS 4
#define LANE_LEAD 5
#define LANE_CHORDS 6
/* Mixer strips. Seven lanes, then the heard master. */
#define METER_N 8
#define METER_MASTER 7
#define METER_RELEASE_SEC 0.15f
#define METER_HOLD_SEC 0.7f

enum {
    P_NONE = 0,
    P_FREQ,
    P_DECAY,
    P_PBEND,
    P_BTIME,
    P_BODY,
    P_CLICK,
    P_NOISE,
    P_DIST,
    P_BDCY,
    P_NDCY,
    P_SNAP,
    P_TONE,
    P_METAL,
    P_COLOR,
    P_ATK,
    P_RING,
    P_POS,
    P_MAT,
    P_FM,
    P_RATIO,
    P_DAMP,
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
    P_NOTE_DRIVE,
    P_GLIDE,
    P_SUSTAIN,
    P_ENV
};

/* Coefficients of one filter. Reused while cutoff and resonance hold still. */
typedef struct {
    float cut, res, a1, a2, a3, k, trim;
    int lp, on;
} FltCache;

typedef struct {
    int on;
    int lane;
    float phase0, phase1, phase2, phase3, click_phase;
    float env, noise_env, pitch_env, click_env;
    int age;
    float freq, decay, noise_decay, bend_time, bend;
    float body, noise, tone, click, drive, fm, ratio, ring, pos, damp;
    float cutoff, resonance, reverb, delay, nlp, nhp, flt, band;
    FltCache coef;
    float env_k, noise_k, pitch_k, click_k, gain;
    int loop;
    float haas[HAAS_N];
    int haas_i;
} Drum;

typedef struct {
    float freq, wave, mf, ff, body;
    int m0, m1, f0, ready;
} WaveFix;

typedef struct {
    int on;
    float phase[3], slave[3], env, freq;
    float wave, bend, sync, fold, drive, wide;
    /* Unison ratios and the wavetable cursor. Rebuilt when wide, wave or frequency changes. */
    float wide_key, side_w, uni_norm, ratio_lo, ratio_hi;
    WaveFix osc[3];
    float cutoff, resonance, reverb, delay, attack, release, gain, low, band;
    FltCache coef;
    float target, glide, sustain, env_amt, filter_env, from_amp, from_contour;
    int age, left, gate, lane, pitch, loop, claim, legato;
    float haas[HAAS_N];
    int haas_i;
} Note;

typedef struct {
    int param;
    int pattern;
    float value, cycle, amount;
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

/* Morph fade. kind 0 dips, 1 fades in, 2 fades out. Lane 7 is the fx return. */
typedef struct {
    int lane;
    int kind;
    int start;
    int commit;
    int end;
} Handoff;

typedef struct {
    float *buf;
    int n;
    int i;
} Line;

typedef struct {
    Line preL, preR, earlyL, earlyR, in0, in1, in2, in3, modL, modR, dL1, dL2, dR1, dR2, apL, apR, shimLine;
    float dampL, dampR, hpL, hpR, bw, right, lfo, scale, shimPhase, shimLp;
    int quiet;
    float size, decay, air, spin, shim, level;
} Plate;

typedef struct {
    Line l, r;
    float lpL, lpR, phase, hold, follow;
    int quiet;
    float time, feed, tone, duck, ping, taps, wow, level;
} Echo;

typedef struct {
    uint32_t noise;
    float tempo;
    float beats;
    float glue, pump, wide, tilt;
    float pump_env, glue_gain, tilt_l, tilt_r;
    Plate plate;
    Echo echo;
    /* Delay throw. Knobs stay latched after the pad so the tail keeps its time. */
    Echo throw_echo;
    char block[TEXT_CAP];
    int has_block;
    char *phrase_text;
    int phrase_pending;
    int phrase_on;
    int phrase_count;
    int clock;
    unsigned phrase_sig;
    Handoff handoff[8];
    int handoff_n;
    LaneBox lanes[LANE_COUNT];
    PhraseEv phrase[PHRASE_CAP];
    /* Voice-pattern envelopes. Painted once per phrase, read in the callback. */
    float env[ENV_LANES][ENV_CAP];
    int env_n[ENV_LANES];
    int env_loop[ENV_LANES];
    int env_hop[ENV_LANES];
    unsigned env_stamp;
    int env_ready;
    Drum drums[DRUMS];
    Note notes[NOTES];
    /* Smoothed render share of the callback slack, 0..99. */
    int cpu_pct;
    int cpu_avg;
    /* Master platter. lead is samples already rendered past clock. */
    float *deck_l;
    float *deck_r;
    int deck_mask;
    int deck_filled;
    int deck_lead;
    int deck_warm;
    int deck_gesture;
    int deck_command;
    int deck_serial;
    int deck_down;
    int deck_up;
    float deck_k[8];
    /* filter, resonance, drive, low, mid, high. Factory is a bypass. */
    float deck_tone[6];
    float tone_lo_l[2];
    float tone_hi_l[2];
    float tone_lo_r[2];
    float tone_hi_r[2];
    float tone_flt_l[2];
    float tone_flt_r[2];
    FltCache tone_cache_l;
    FltCache tone_cache_r;
    int deck_seed;
    float deck_bar;
    float *deck_peak_l;
    float *deck_peak_r;
    int deck_view_head;
    int deck_view_span;
    float lane_freq[LANE_COUNT];
    int arm_serial;
    int arm_clock;
    /* Voice pattern on velocity. Source -1 is off. Two taps cover both generators. */
    int duck_source[7][2];
    float duck_value[7][2];
    float duck_amount[7][2];
    int duck_n[7];
    /* Peak of the lane before its own duck, and after the duck and the pump. */
    float dry_env[7];
    float wet_env[7];
    /* Linear followers for the mixer strips. Index 7 is the heard master. */
    float meter_level[METER_N];
    float meter_peak[METER_N];
    float meter_hold[METER_N];
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

#define WT_FRAMES 48
#define WT_CYCLE 256
#define WT_MIPS 7
#define WT_HARM 64
#define WT_RMS 0.70710678118f
#define NOTE_LEVEL 0.22f
#define UNI_CENTS 25.0f
#define UNI_PAN 0.35f
#define MELODY_FALL 4.0f
#define FIRE_CAP 256
#define FOLLOW_STRIDE 8
#define DECK_FADE 353
#define CPU_SLACK_NS_128 2370000LL
#define CPU_SMOOTH_SHIFT 8

typedef struct { float r2, a2, r3, a3, shape, fm; } Spectrum;

typedef struct {
    int kind;
    float amp, a, b, c, hold, attack, release;
} EnvShape;

typedef struct {
    float pos;
    float live;
    float gain;
    float throw_amt;
    float rate;
} DeckRead;

typedef struct {
    int offset;
    int index;
} Fire;

float rng(Engine *engine);
float read_param(const char *params, const char *suffix, float fallback);
float soft(float sample);
float gauss_k(float k, float center, float sigma);
float anchor_amp(int kind, int k);
float amp_at(float p, int k);
float harm_window(int k, int max_h);
void ensure_wave_table(void);
float read_cycle(int mip, int frame, float u);
float read_wave(float freq, float wave, float u);
void wave_fix(WaveFix *fix, float freq, float wave);
float wave_read(const WaveFix *fix, float u);
float bend_unit(float u, float bend);
float unison_phase(int pitch, int lane, int sample, int copy);
float unison_weight(float wide, int index);
float unison_cents(float wide, int index);
float unison_pan(float wide, int index);
float advance_osc(Note *note, int index, float inc, float sync, float bend, float wave);
int suffix_is(const char *id, const char *suffix);
float wrap01(float phase);
float clampf01(float value);
float drum_pitch_hz(int lane, float unit);
float squared_seconds(float unit, float lo, float span);
float kick_decay_seconds(float unit);
float bend_time_seconds(float unit);
float snare_body_decay_seconds(float unit);
float snare_noise_decay_seconds(float unit);
float hat_decay_seconds(float unit);
float perc_decay_seconds(float unit);
void snare_pitch_bend(float body, float *bend, float *bend_time);
float pole_coef(float hz);
float fm_ratio_of(float unit);
float fade01(float u, float a, float b);
float lerp_stops(const float *stops, int n, float t);
float perc_noise_amt(float material);
float perc_tone(float material);
float euclid_gate(int steps, int pulses, float phase);
float motif_at(int id, float phase01);
int param_of(const char *id);
float eval_one(float value, int pattern, float cycle, float amount, float step);
void refresh_drum_env(Drum *drum);
float glide_seconds(float unit);
float melody_cutoff(float cutoff, float env, float contour);
float melody_release_seconds(float unit);
float melody_attack_samples(float gate, float attack);
float melody_fall(float from, float to, float u);
float melody_level(float age, float gate, float attack, float sustain, float release_sec, int legato, float origin);
float melody_contour(float age, float gate, float attack, int legato, float origin);
float melody_sustain_of(const char *params);
void apply_drum(Drum *drum, int param, float unit);
void apply_note(Note *note, int param, float unit);
void stamp_note(Engine *engine, Note *note);
void stamp_held(Engine *engine);
float decay_level(float amp, float age, float seconds);
int ticks_to_samples(int ticks, float tempo);
void shape_of(const PhraseEv *hit, float tempo, EnvShape *s);
float shape_level(const EnvShape *s, float age);
int shape_horizon(const EnvShape *s, int loop);
unsigned env_mix(unsigned h, unsigned v);
unsigned envelope_stamp(const Engine *engine);
void bake_envelopes(Engine *engine);
float baked_envelope(const Engine *engine, int lane, int sample);
float eval_voice(const Engine *engine, const LaneMotion *motion, float step, int at);
void follow_sound(Engine *engine);
void arm_drum(Engine *engine, int lane, int note, int velocity, const char *params, int loop);
float note_amp(const Note *note);
Note *steal(Engine *engine);
float midi_freq(int pitch);
int begin_arm(Engine *engine);
Note *glide_voice(Engine *engine, int lane, int pitch, int serial);
void paint_note(Note *note, int note_num, int velocity, int samples, const char *params, int lane, int loop);
Note *arm_note(Engine *engine, int note_num, int velocity, int ticks, const char *params, int lane, int loop);
Note *arm_fresh(Engine *engine, Note *note, int note_num, int velocity, int ticks, const char *params, int lane, int loop);
float clip_peak(float x);
float filter_sample(float *low, float *band, FltCache *coef, float input, float cutoff, float resonance);
float wrap_phase(float phase);
Spectrum spec_row(const float *table, int index);
Spectrum shelf_spec(const float *table, const float *centers, int n, float t);
void tonal_body(Drum *drum, float freq, float *mid, float *side);
void hat_body(Drum *drum, float freq, float *mid, float *side);
float noise_sample(Engine *engine, Drum *drum);
float transient_sample(Engine *engine, Drum *drum);
float shape_drive(float sample, float drive);
void drum_sample(Engine *engine, Drum *drum, float *left, float *right);
float shape_note(float sample, float fold, float drive);
void slew_note(Note *note);
void note_sample(Engine *engine, Note *note, float *left, float *right);
void push_lane(Engine *engine, int lane, int param, float value, int pattern, float cycle, float amount);
int line_make(Line *line, int n);
void line_free(Line *line);
void line_clear(Line *line);
float line_read(const Line *line, float delay);
void line_write(Line *line, float x);
float line_ap(Line *line, float delay, float x, float g);
float line_delay(Line *line, float samples, float x);
float paper_scale(void);
int tank_len(float base);
float sized_delay(float base, float scale);
void throw_preset(Echo *e, int row);
int fx_init(Engine *engine);
void fx_free(Engine *engine);
void pan_gains(float pos, float *gl, float *gr);
void open_hat(float *l, float *r, float pos, float wide);
void pan_chord(float *l, float *r, int pitch, int lo, int hi, float wide);
void haas(float *buf, int *index, float *l, float *r, float wide);
void pump_pair(Engine *engine, int lane, float *l, float *r);
void decay_pump(Engine *engine);
float tilt_coef(void);
void tilt_mix(Engine *engine, float *l, float *r);
float shave(float x, float glue);
float glue_coef(int attack);
void glue_mix(Engine *engine, float *l, float *r);
void bus_clear(Engine *engine);
void apply_bus(Engine *engine, const char *text);
void echo_clear(Echo *e);
void fx_clear(Engine *engine);
void apply_fx(Engine *engine, const char *text);
float smooth_pole(float state, float x, float coef);
float plate_hp(void);
float decay_gain(float decay, float scale);
void air_hz(float air, float *bw, float *damp);
float follow_scale(float current, float target);
void spin_of(float spin, float scale, float *rate, float *excursion);
float early_cluster(Line *line, float x, const float *sec, const float *gain, float scale);
float raised(float t);
float shim_pole(void);
float shimmer(Plate *p, float x, float amount);
void plate_sample(Engine *engine, float inL, float inR, float *outL, float *outR);
float duck_release(void);
float tap_place(float main, float step, int k);
float tap_gain(float taps, int index);
float tone_sample(Echo *e, int right, float x);
float follow_delay(float current, float target);
void echo_sample(Engine *engine, Echo *e, float inL, float inR, float *outL, float *outR);
float smooth_gain(float t);
float handoff_gain(const Engine *engine, int lane, int sample);
void apply_handoff(Engine *engine, char *text);
void ingest_phrase(Engine *engine);
unsigned phrase_timing_sig(const Engine *engine);
void catch_holding(Engine *engine);
int deck_pick(float value, int count);
int deck_mod(int n, int m);
int deck_beat(float tempo);
int deck_div(const Engine *engine);
int deck_len(const Engine *engine);
int deck_brake(const Engine *engine);
int deck_bar_samples(const Engine *engine);
int deck_quant(const Engine *engine);
int deck_snap(int sample, int unit);
DeckRead deck_identity(int now);
DeckRead deck_stopped(float pos);
float deck_brake_rate(float elapsed, float span);
float deck_brake_pos(float elapsed, float span, float origin);
DeckRead deck_spin(float origin, float now, float target);
void deck_shuffle(unsigned seed, int window_index, int count, int *order);
unsigned deck_hash(unsigned seed, int window_index, int slot, int salt);
DeckRead deck_glitch(const Engine *engine, int origin, int now, int y);
float deck_unit(float value);
void deck_scratch_clock(float phase, float ramp, float *out_phase, float *dir, float *d_warp);
void deck_scratch_hand(int shape, float phase, float *pos, float *dpos);
void deck_scratch_stroke(int shape, float phase, int *note, float *local);
float deck_scratch_gain(int note, float local, float cut);
unsigned scratch_next(unsigned state);
void deck_scratch_roll(int duration_index, int complexity, int seed, int press, int *lens, int *types, int *signs, int *count, int *sum);
DeckRead deck_scratch(const Engine *engine, int origin, int now, int len, int shape);
DeckRead deck_group(const Engine *engine, int gesture, int now);
DeckRead deck_gesture(const Engine *engine, int gesture, int now);
DeckRead deck_read(Engine *engine);
float deck_throw(Engine *engine);
int throw_row(int gesture);
void deck_peak_note(Engine *engine, int now, float left, float right);
void deck_hear(Engine *engine, float *l, float *r);
void deck_capture_view(Engine *engine);
int deck_name(const char *s);
void deck_apply_text(Engine *engine, const char *text);
float deck_tone_cascade(float *pole, float input, float coef);
float deck_iso_gain(float knob);
float deck_isolate(float *low_pole, float *high_pole, float input, float low, float mid, float high);
float deck_drive(float input, float drive);
void deck_tone_color(Engine *engine, float *l, float *r);
int fire_cmp(const void *a, const void *b);
void render(Engine *engine, int16_t *out, int frames);
void *create_instance(const char *module_dir, const char *json_defaults);
void set_param(void *instance, const char *key, const char *val);
void destroy_instance(void *instance);
void on_midi(void *instance, const uint8_t *msg, int len, int source);
int64_t mono_ns(void);
void account_cpu(Engine *engine, int64_t spent_ns, int frames);
void follow_meters(Engine *engine, const float *block, int frames);
int meter_byte(float peak);
int meter_key(const char *key);
int meter_page(const Engine *engine, char *buf, int buf_len);
int cpu_key(const char *key);
int wave_key(const char *key);
void wave_column(const Engine *engine, float from, float to, float *pl, float *pr);
char wave_nibble(float peak);
int wave_page(const Engine *engine, int page, char *buf, int buf_len);
int get_param(void *instance, const char *key, char *buf, int buf_len);
int get_error(void *instance, char *buf, int buf_len);
void render_block(void *instance, int16_t *out, int frames);
plugin_api_v2_t *move_plugin_init_v2(void *host);

#endif
