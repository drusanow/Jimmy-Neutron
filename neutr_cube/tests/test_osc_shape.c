/* Host test for neutr_src/osc_shape.c
 * Compares the new shape processing with the original 1.5f code:
 *   - cv resolution (step size while the knob moves slowly)
 *   - wave pair switching only at crossfade extremes (switched side muted)
 *   - no wave pair chatter with a noisy knob resting on a segment border
 *   - drift range and that depth 0 means no drift
 */
#include <stdio.h>
#include <stdlib.h>
#include "neutron.h"
#include "menu.h"

GPIO_TypeDef host_gpioa, host_gpiob, host_gpioc;
DAC_TypeDef host_dac;
TIM_TypeDef host_tim2;

volatile parameters_t parameters;
volatile uint16_t adc_input[POT_TOTAL];
volatile uint16_t dac_output[CV_TOTAL];
const uint32_t ADC_SCALER = (0xFFF0000 / POT_MAX_VALUE);

static int failures;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; printf("FAIL: " __VA_ARGS__); printf("\n"); } } while (0)

static int seg_of_bsrr(uint32_t bsrr)
{
	for (int i = 0; i < 4; i++)
		if (o1w[i] == bsrr)
			return i;
	return -1;
}

/* original 1.5f code for osc1 */
static uint16_t orig_cv;
static int orig_seg;
static void orig_process(uint16_t adc)
{
	uint32_t p = (adc * ADC_SCALER) >> 19;
	orig_seg = p >> 7;
	orig_cv = ~sine[p & 0xFF];
}

static uint16_t noisy(int32_t v, int amp)
{
	v += amp ? (rand() % (2 * amp + 1)) - amp : 0;
	if (v < 0) v = 0;
	if (v > 0xFFF) v = 0xFFF;
	return v;
}

static void settle(uint16_t adc, int n)
{
	for (int i = 0; i < n; i++) {
		adc_input[POT_OSC1SHAPE] = adc;
		osc_shape_process(0);
	}
}

int main(void)
{
	parameters.shpdrift_depth = 0;
	parameters.shpdrift_rate = 0x600;

	/* 1 - slow sweep: compare largest cv step */
	int max_new = 0, max_orig = 0, bad_switch = 0, nswitch = 0;
	settle(0, 2000);
	int prev_seg = seg_of_bsrr(host_gpiob.BSRR);
	int prev_cv = dac_output[CV_OSC1WAVE];
	orig_process(0);
	int prev_ocv = orig_cv;
	for (int i = 0; i <= 0xF00 * 8; i++) {      /* full sweep in ~5 s at 6 kHz */
		uint16_t adc = i / 8;
		adc_input[POT_OSC1SHAPE] = adc;
		osc_shape_process(0);
		orig_process(adc);
		int cv = dac_output[CV_OSC1WAVE];
		int seg = seg_of_bsrr(host_gpiob.BSRR);
		if (abs(cv - prev_cv) > max_new) max_new = abs(cv - prev_cv);
		if (abs((int)orig_cv - prev_ocv) > max_orig && seg == orig_seg) max_orig = abs((int)orig_cv - prev_ocv);
		if (seg != prev_seg) {
			nswitch++;
			/* switched side must be muted: crossfade at an extreme */
			uint16_t x = ~cv;
			if (!(x > 0xF000 || x < 0x1000))
				bad_switch++;
		}
		prev_seg = seg; prev_cv = cv; prev_ocv = orig_cv;
	}
	printf("sweep: largest cv step new=%d orig=%d (of 65535), wave switches=%d\n", max_new, max_orig, nswitch);
	CHECK(nswitch == 3, "expected 3 wave pair switches, got %d", nswitch);
	CHECK(bad_switch == 0, "%d wave switches away from crossfade extreme", bad_switch);
	CHECK(max_new * 8 < max_orig, "new cv steps not much finer than original");

	/* 2 - steady state matches original mapping (away from borders) */
	int maxdiff = 0;
	for (uint16_t adc = 0x80; adc < 0xE80; adc += 0x37) {
		settle(adc, 3000);
		orig_process(adc);
		int d = abs((int)dac_output[CV_OSC1WAVE] - (int)orig_cv);
		if (d > maxdiff) maxdiff = d;
		CHECK(seg_of_bsrr(host_gpiob.BSRR) == orig_seg, "segment differs from original at adc %x", adc);
	}
	printf("steady state: largest difference to original cv = %d (orig step is up to ~%d)\n", maxdiff, max_orig);
	CHECK(maxdiff <= max_orig, "steady state cv off from original by %d", maxdiff);

	/* 3 - knob resting on a border with adc noise */
	uint16_t border = (0x4000 << 12) / ADC_SCALER + 1;  /* adc value at segment 0/1 border */
	int chatter_new = 0, chatter_orig = 0;
	settle(border, 3000);
	prev_seg = seg_of_bsrr(host_gpiob.BSRR);
	orig_process(border);
	int prev_oseg = orig_seg;
	for (int i = 0; i < 60000; i++) {               /* 10 s */
		uint16_t adc = noisy(border, 4);
		adc_input[POT_OSC1SHAPE] = adc;
		osc_shape_process(0);
		orig_process(adc);
		int seg = seg_of_bsrr(host_gpiob.BSRR);
		if (seg != prev_seg) chatter_new++;
		if (orig_seg != prev_oseg) chatter_orig++;
		prev_seg = seg; prev_oseg = orig_seg;
	}
	printf("noisy knob on border, 10 s: wave switches new=%d orig=%d\n", chatter_new, chatter_orig);
	CHECK(chatter_new == 0, "wave pair chatters with resting knob");

	/* 4 - drift */
	parameters.shpdrift_depth = 0xFFF;
	parameters.shpdrift_rate = 0xFFF;
	uint16_t mid = 0x780;
	settle(mid, 6000);
	int lo = 1 << 30, hi = -(1 << 30);
	for (int i = 0; i < 6000 * 20; i++) {
		adc_input[POT_OSC1SHAPE] = mid;
		osc_shape_process(0);
		extern int32_t host_shape_pos(uint8_t osc);
		int p = host_shape_pos(0);
		if (p < lo) lo = p;
		if (p > hi) hi = p;
	}
	printf("drift max depth/rate: position range %d..%d around %d (segment = 16384)\n", lo, hi, (int)((mid * ADC_SCALER) >> 12));
	CHECK(hi - lo > 0x3000 && hi - lo < 0x4400, "drift range %d unexpected", hi - lo);

	parameters.shpdrift_depth = 0;
	settle(mid, 6000);
	lo = 1 << 30; hi = -(1 << 30);
	for (int i = 0; i < 6000 * 5; i++) {
		adc_input[POT_OSC1SHAPE] = mid;
		osc_shape_process(0);
		extern int32_t host_shape_pos(uint8_t osc);
		int p = host_shape_pos(0);
		if (p < lo) lo = p;
		if (p > hi) hi = p;
	}
	CHECK(hi - lo <= 1, "depth 0 still moves (%d)", hi - lo);

	printf(failures ? "osc_shape: %d FAILED\n" : "osc_shape: all passed\n", failures);
	return failures != 0;
}
