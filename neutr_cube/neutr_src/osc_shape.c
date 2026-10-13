/*

This file is part of neutr_cube project.

neutr_cube is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

neutr_cube is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with
neutr_cube. If not, see <http://www.gnu.org/licenses/>.
 *
 * osc_shape.c
 *
 * Analog oscillator shape control.
 *
 * Each osc has 4 wave pairs (selected with 2 gpio bits) and a crossfade cv.
 * The shape knob position is split into 4 segments. Inside a segment the cv moves
 * from one end of the crossfader to the other (half a cycle of the sine table), so
 * the wave pair is switched only when the switched side is muted.
 *
 * Compared to the original code:
 *  - knob is smoothed with a one pole filter (no zipper from adc noise)
 *  - crossfade cv is interpolated, ~12 bit instead of 128 steps per segment
 *  - wave pair switch has hysteresis, so a knob resting on a border does not chatter
 *  - optional slow drift: two slow sines (non harmonic ratio) move the shape position
 *    around the knob position. osc2 drifts at a different rate than osc1.
 */

#include "neutron.h"
#include "menu.h"

extern volatile uint16_t adc_input[POT_TOTAL];
extern volatile uint16_t dac_output[CV_TOTAL];
extern const uint32_t ADC_SCALER;

//called at 6 kHz per osc. 1<<6 samples = ~10.7 mS time constant
#define SHP_SMOOTH_SHIFT 6
//distance past a segment border before wave pair switch, in 0..0xFFFF position units
#define SHP_HYST 0x80
//shape position range is 0..0xFFFF, 4 segments
#define SHP_SEG_SHIFT 14
//maximum drift excursion is (0xFFF*0xFFF)>>11 = ~0x1FFC = half of a segment
#define SHP_DEPTH_SHIFT 11

typedef struct
{
	int32_t pos;      //smoothed position, <<8
	uint8_t seg;      //selected wave pair
	uint32_t ph_a;    //drift phases
	uint32_t ph_b;
}shp_state_t;

static shp_state_t shp[2] =
{
	{0, 0, 0x00000000, 0x00000000},
	{0, 0, 0x55000000, 0xA0000000},
};

//drift rate pot to phase increment @6 kHz: 0.03 Hz .. ~5 Hz, quadratic for finer low rates
static inline uint32_t shp_drift_inc(void)
{
	uint32_t k = parameters.shpdrift_rate & 0xFFF;
	return 21475 + ((k*k)>>10) * 217;
}

//sum of two sines, ratio 1 : 0.625, result -0x7FFF..0x7FFF
static inline int32_t shp_drift(shp_state_t* s, uint32_t inc)
{
	s->ph_a += inc;
	s->ph_b += inc - (inc>>2) - (inc>>3);
	int32_t a = (int32_t)sine[s->ph_a>>24] - 0x8000;
	int32_t b = (int32_t)sine[s->ph_b>>24] - 0x8000;
	return (a*5 + b*3)>>3;
}

void osc_shape_process(uint8_t osc)
{
	shp_state_t* s = &shp[osc];
	int32_t target = (adc_input[POT_OSC1SHAPE + osc] * ADC_SCALER) >> 12;

	uint32_t depth = parameters.shpdrift_depth & 0xFFF;
	if (depth)
	{
		uint32_t inc = shp_drift_inc();
		if (osc)
			inc = (inc * 11)>>3;
		int32_t d = (depth * depth)>>SHP_DEPTH_SHIFT;
		target += (shp_drift(s, inc) * d)>>15;
	}
	if (target < 0)
		target = 0;
	if (target > 0xFFFF)
		target = 0xFFFF;

	s->pos += ((target<<8) - s->pos) >> SHP_SMOOTH_SHIFT;
	uint32_t pos = (uint32_t)s->pos >> 8;

	uint8_t seg = pos >> SHP_SEG_SHIFT;
	if (seg > s->seg)
	{
		if ((seg > s->seg + 1) || ((pos - ((uint32_t)seg << SHP_SEG_SHIFT)) >= SHP_HYST))
			s->seg = seg;
	}
	else if (seg < s->seg)
	{
		if ((seg + 1 < s->seg) || ((((uint32_t)s->seg << SHP_SEG_SHIFT) - pos) >= SHP_HYST))
			s->seg = seg;
	}

	//interpolated crossfade, same curve as original: sine[(pos>>7)&0xFF]
	uint32_t idx = (pos>>7) & 0xFF;
	int32_t a = sine[idx];
	int32_t cv = a + (((sine[idx + 1] - a) * (int32_t)(pos & 0x7F))>>7);

	if (osc)
	{
		OSCWAVEPORT = o2w[s->seg];
		dac_output[CV_OSC2WAVE] = (uint16_t)~cv;
	}
	else
	{
		OSCWAVEPORT = o1w[s->seg];
		dac_output[CV_OSC1WAVE] = (uint16_t)~cv;
	}
}

#ifdef HOST_TEST
int32_t host_shape_pos(uint8_t osc)
{
	return shp[osc].pos >> 8;
}
#endif
