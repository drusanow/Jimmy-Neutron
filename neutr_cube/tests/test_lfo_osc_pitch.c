/* Host test for neutr_src/lfo_osc_pitch.c
 *  - free mode reproduces the 1.5f pitch exactly
 *  - quantized offset lands on semitones, covers the range, and does not flicker
 *  - osc1/osc2 source selection
 */
#include <stdio.h>
#include <stdlib.h>
#include "neutron.h"
#include "menu.h"
#include "neutr_lfo_common.h"

volatile parameters_t parameters;
volatile lforam_t lforam;
volatile uint16_t lforate;
volatile uint16_t lfoshape;
volatile uint32_t pp_o1p, pp_o2p;
volatile int32_t pp_o1pwshift, pp_o2pwshift;

static int failures;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; printf("FAIL: " __VA_ARGS__); printf("\n"); } } while (0)

static int32_t total_pitch(void) { return LFOOSC_RATEPITCH + lforam.nl3m_pitch; }

int main(void)
{
	pp_o2p = 60u << 24; pp_o1p = 48u << 24; pp_o2pwshift = 100; pp_o1pwshift = -50;

	for (int ks = 0; ks < 2; ks++) {
		parameters.lfokeysync = ks;
		/* free mode == original formula */
		parameters.lfooscquant = 0; parameters.lfooscsrc = 0;
		for (int r = 0; r <= 0xFFF; r += 0x111) {
			lforate = r;
			lfoosc_cr_pitch();
			int32_t orig = r*(3+7*ks) + (pp_o2p>>15) + pp_o2pwshift - (0x1800 + 0x3800*ks);
			CHECK(total_pitch() == orig, "free mode differs at rate %x", r);
		}
		/* quantized: sweep up, offsets are whole semitones, cover the range */
		parameters.lfooscquant = 1;
		int lo = 1000, hi = -1000, steps = 0, prev = -1000;
		for (int r = 0; r <= 0xFFF; r++) {
			lforate = r;
			lfoosc_cr_pitch();
			int32_t off = total_pitch() - ((pp_o2p>>15) + pp_o2pwshift);
			CHECK(off % 512 == 0, "offset %d not on a semitone", off);
			int semi = off / 512;
			if (semi != prev) { steps++; prev = semi; }
			if (semi < lo) lo = semi;
			if (semi > hi) hi = semi;
		}
		printf("keysync %d: quantized range %d..%d semitones\n", ks, lo, hi);
		CHECK(lo == (ks ? -40 : -12) && hi == (ks ? 40 : 12), "range %d..%d", lo, hi);
		CHECK(steps == hi - lo + 1, "semitones skipped or repeated (%d steps)", steps);

		/* noisy knob near a semitone border - no flicker */
		int border = (0x1800 + 0x3800*ks + 256 + 512*3) / (3+7*ks);  /* halfway between +3 and +4 */
		lforate = border; lfoosc_cr_pitch();
		int32_t first = total_pitch(), changes = 0;
		for (int i = 0; i < 10000; i++) {
			lforate = border + (rand() % 9) - 4;
			lfoosc_cr_pitch();
			if (total_pitch() != first) { changes++; first = total_pitch(); }
		}
		CHECK(changes == 0, "quantized pitch flickers (%d changes)", changes);
	}

	/* source selection */
	parameters.lfokeysync = 0; parameters.lfooscquant = 1; lforate = 0x800;
	parameters.lfooscsrc = 0; lfoosc_cr_pitch(); int32_t p2 = total_pitch();
	parameters.lfooscsrc = 1; lfoosc_cr_pitch(); int32_t p1 = total_pitch();
	CHECK(p2 - p1 == (12*512 + 150), "osc1/osc2 source difference %d", p2 - p1);

	printf(failures ? "lfo_osc_pitch: %d FAILED\n" : "lfo_osc_pitch: all passed\n", failures);
	return failures != 0;
}
