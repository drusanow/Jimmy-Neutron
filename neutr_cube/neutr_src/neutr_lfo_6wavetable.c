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
 * neutr_lfo_6wavetable.c
 *
 * Wavetable oscillator on the lfo output.
 *  LFO SHAPE - morph through the 8 waves of wavetables.c
 *  LFO RATE  - pitch offset from the followed osc, same as monophonic mode
 *              (+-12 semitones, +-40 with KEY SYNC lit, optional semitone quantize)
 *  LFO sync input - hard sync (phase reset) on the edge selected in the LFO SYNC menu
 *
 * Every wave has band-limited versions for different pitch ranges, selected
 * from the phase increment, so high notes do not alias.
 */

#include "neutron.h"
#include "menu.h"
#include "neutr_lfo_common.h"
#include "wavetables.h"

#define NLWT_MORPH_MAX (((WT_WAVES - 1)<<12) - 1)
//morph smoothing at control rate, 1<<3 samples = ~2.7 mS
#define NLWT_MORPH_SMOOTH 3

void nlwt_sr(void)
{
	int32_t pitch = LFOOSC_RATEPITCH + lforam.nl3m_pitch;
	if (pitch < 0)
		pitch = 0;
	else if (pitch > 0xFFFF)
		pitch = 0xFFFF;
	uint16_t tablepos = pitch>>8;
	uint8_t subpos = (uint8_t)pitch;
	uint32_t inc = ((oscinc[tablepos+1].inc - oscinc[tablepos].inc)>>8)*subpos + oscinc[tablepos].inc;

	//band limited level for this pitch
	uint32_t lvl = 0;
	uint32_t lim = WT_LEVEL0_INC;
	while ((inc > lim) && (lvl < WT_LEVELS - 1))
	{
		lvl++;
		lim <<= 1;
	}

	//hard sync from the lfo sync input. edge mask as in the other modes: 0 - rise, 1 - fall, 2 - both
	uint32_t ph;
	uint8_t irq = lforam.irqstate;
	if (irq)
	{
		lforam.irqstate = 0;
		if (irq & (parameters.lfoextsynctype + 1))
			lforam.phaseacc = 0;
		NVIC_EnableIRQ(EXTI2_3_IRQn);
	}
	ph = lforam.phaseacc + inc;
	lforam.phaseacc = ph;

	//index is the top bits of the phase, 12 bit fraction below
	uint32_t bits = wavetable_level_bits[lvl];
	uint32_t idx = ph>>(32 - bits);
	int32_t frac = (ph>>(20 - bits)) & 0xFFF;
	uint32_t m = lforam.nlwt_morph;
	//lforam is shared with other modes - sr may run once before nlwt_init on a mode switch
	if (m > NLWT_MORPH_MAX)
		m = NLWT_MORPH_MAX;
	uint32_t w = m>>12;
	int32_t mf = m & 0xFFF;

	const int16_t* ta = &wavetable[w][wavetable_level_offset[lvl]];
	const int16_t* tb = &wavetable[w + 1][wavetable_level_offset[lvl]];
	int32_t a = ta[idx] + (((ta[idx + 1] - ta[idx]) * frac)>>12);
	int32_t b = tb[idx] + (((tb[idx + 1] - tb[idx]) * frac)>>12);
	int32_t out = a + (((b - a) * mf)>>12);

	LFO_OUTPUT = (uint16_t)(out + 0x8000);
}

void nlwt_cr(void)
{
	lfoosc_cr_pitch();
	//0..0xFFF -> 0..(WT_WAVES-1)<<12 without division
	int32_t target = ((uint32_t)lfoshape * (WT_WAVES - 1) * 4097)>>12;
	if (target > NLWT_MORPH_MAX)
		target = NLWT_MORPH_MAX;
	int32_t m = lforam.nlwt_morph;
	m += (target - m) >> NLWT_MORPH_SMOOTH;
	lforam.nlwt_morph = m;
}

void nlwt_init(uint8_t prevmode)
{
	nl_init_classic(prevmode); //exti on, sync state cleared
	lforam.nlwt_morph = 0;
	lforam.nl3m_qsemi = 0;
}

void nlex_leds(uint32_t frame);

const neutr_lfo_t nl_6wavetable =
{
		0,           //void (*retrig)(void);
		nlwt_cr,     //void (*cr)(void);
		nlwt_sr,     //void (*sr)(void);
		nlex_leds,   //void (*lfoleds)(uint32_t time); - morph position
		0,           //void (*noteon)(uint8_t note, uint32_t ts);
		0,           //void (*noteoff)(uint8_t note, uint32_t ts);
		0,           //void (*damper)(uint8_t val, uint32_t ts);
		0,           //void (*panic)(void);
		0,           //void (*asyncmain)(void);
		nlwt_init    //void (*initialize)(uint8_t prevmode);
};
