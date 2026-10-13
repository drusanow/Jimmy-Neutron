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
 * lfo_osc_pitch.c
 *
 * Pitch of the lfo when it works as an oscillator (monophonic and wavetable modes).
 * Pitch units: 512 per semitone (same as pp_o1p>>15).
 *
 * pitch = osc pitch (osc1 or osc2, with pitch wheel) + LFO RATE offset
 * LFO RATE offset is +-12 semitones, or +-40 with KEY SYNC lit (as in 1.5f).
 * With quantize on, the offset snaps to semitones, with hysteresis.
 */

#include "neutron.h"
#include "menu.h"
#include "neutr_lfo_common.h"

extern volatile uint32_t pp_o1p;
extern volatile uint32_t pp_o2p;
extern volatile int32_t pp_o1pwshift;
extern volatile int32_t pp_o2pwshift;

#define LOP_SEMITONE 512
//rounding of negative numbers with shifts only
#define LOP_QBIAS 64

void lfoosc_cr_pitch(void)
{
	int32_t range_off = 0x1800 + 0x3800*parameters.lfokeysync;
	int32_t base;
	if (parameters.lfooscsrc)
		base = (pp_o1p>>15) + pp_o1pwshift;
	else
		base = (pp_o2p>>15) + pp_o2pwshift;
	lforam.nl3m_pitch = base - range_off;

	//always tracked, so switching quantize on never uses a stale value
	int32_t x = lforate*(3+7*parameters.lfokeysync) - range_off;
	int32_t cur = lforam.nl3m_qsemi * LOP_SEMITONE;
	if ((x > cur + LOP_SEMITONE*3/4) || (x < cur - LOP_SEMITONE*3/4))
		lforam.nl3m_qsemi = ((x + LOP_SEMITONE/2 + LOP_SEMITONE*LOP_QBIAS) >> 9) - LOP_QBIAS;
	lforam.nl3m_qoff = lforam.nl3m_qsemi * LOP_SEMITONE + range_off;
}
