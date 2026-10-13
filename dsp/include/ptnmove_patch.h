#ifndef PTNMOVE_PATCH_H
#define PTNMOVE_PATCH_H

#include <stdint.h>

/* Semantic event handed to the DSP. sample_offset is within the 128-frame block. */

#define PTNMOVE_MAX_PARAMS 8

typedef struct ptnmove_param {
    char id[24];
    float value;
} ptnmove_param;

typedef struct ptnmove_event {
    uint32_t sample_offset;
    uint8_t lane; /* 0 kick .. 6 chords */
    uint8_t note;
    uint8_t velocity; /* 1..127 */
    uint16_t length_ticks;
    uint8_t param_count;
    ptnmove_param params[PTNMOVE_MAX_PARAMS];
} ptnmove_event;

#endif
