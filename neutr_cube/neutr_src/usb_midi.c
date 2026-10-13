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
 * usb_midi.c
 *
 * Class compliant USB MIDI device (TinyUSB, Middlewares/tinyusb).
 *
 *  USB -> synth: same messages as DIN MIDI (notes, pitch wheel, mod wheel, breath,
 *                sustain, all notes/sound off, aftertouch, clock, start).
 *                The channel is the one selected with the back panel switches.
 *  DIN -> USB:   everything received on DIN MIDI IN is also sent to the computer
 *                (active sensing and sysex excluded).
 *
 * TinyUSB handles the interrupt and puts data into fifos, usbmidi_task() in the main
 * loop does the rest. USB messages arrive complete, so they bypass the DIN byte parser
 * (which keeps its own running status) and call the synth directly. Synth input
 * functions are also called from the MIDI uart and control rate interrupts, so those
 * two are masked while a USB message is dispatched.
 */

#include "tusb.h"
#include "neutron.h"
#include "menu.h"
#include "neutr_lfo_common.h"

extern volatile uint8_t midi_channel_switch;
extern volatile uint16_t pp_modwheel;
extern volatile uint8_t pp_aftertouch;
void midiclock(void);
void midistart(void);

//////////////////////////////////////////////////////////////////////////////
// descriptors

//pid.codes open source test VID/PID - class compliant, no driver needed
#define USB_VID 0x1209
#define USB_PID 0x0001

enum
{
	ITF_NUM_MIDI = 0,
	ITF_NUM_MIDI_STREAMING,
	ITF_NUM_TOTAL
};

#define EPNUM_MIDI_OUT 0x01
#define EPNUM_MIDI_IN  0x81

static const tusb_desc_device_t desc_device =
{
	.bLength            = sizeof(tusb_desc_device_t),
	.bDescriptorType    = TUSB_DESC_DEVICE,
	.bcdUSB             = 0x0200,
	.bDeviceClass       = 0x00, //class is defined per interface
	.bDeviceSubClass    = 0x00,
	.bDeviceProtocol    = 0x00,
	.bMaxPacketSize0    = CFG_TUD_ENDPOINT0_SIZE,
	.idVendor           = USB_VID,
	.idProduct          = USB_PID,
	.bcdDevice          = 0x0160,
	.iManufacturer      = 0x01,
	.iProduct           = 0x02,
	.iSerialNumber      = 0x03,
	.bNumConfigurations = 0x01
};

#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_MIDI_DESC_LEN)

static const uint8_t desc_configuration[] =
{
	TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, CONFIG_TOTAL_LEN, 0x00, 100),
	TUD_MIDI_DESCRIPTOR(ITF_NUM_MIDI, 0, EPNUM_MIDI_OUT, EPNUM_MIDI_IN, 64)
};

uint8_t const * tud_descriptor_device_cb(void)
{
	return (uint8_t const *)&desc_device;
}

uint8_t const * tud_descriptor_configuration_cb(uint8_t index)
{
	(void)index;
	return desc_configuration;
}

static const char* const string_desc[] =
{
	"",                     //0 - language, handled below
	"neutr_cube",           //1 - manufacturer
	"Neutron neutr_cube",   //2 - product
};

static uint16_t desc_str[1 + 32];

uint16_t const* tud_descriptor_string_cb(uint8_t index, uint16_t langid)
{
	(void)langid;
	uint8_t len;
	if (index == 0)
	{
		desc_str[1] = 0x0409; //english
		len = 1;
	}
	else if (index == 3)
	{
		//serial number from the chip unique id, so several units can be told apart
		uint32_t uid = *(volatile uint32_t*)UID_BASE ^ *(volatile uint32_t*)(UID_BASE + 4) ^ *(volatile uint32_t*)(UID_BASE + 8);
		for (len = 0; len < 8; len++)
		{
			uint8_t nib = (uid >> (28 - 4*len)) & 0xF;
			desc_str[1 + len] = nib < 10 ? '0' + nib : 'A' + nib - 10;
		}
	}
	else if (index < sizeof(string_desc)/sizeof(string_desc[0]))
	{
		const char* s = string_desc[index];
		for (len = 0; s[len] && len < 32; len++)
		{
			desc_str[1 + len] = s[len];
		}
	}
	else
	{
		return 0;
	}
	desc_str[0] = (uint16_t)((TUSB_DESC_STRING << 8) | (2*len + 2));
	return desc_str;
}

//////////////////////////////////////////////////////////////////////////////
// DIN MIDI IN -> USB. the uart interrupt writes, usbmidi_task() reads

#define DIN2USB_BUFSIZE 64
static volatile uint8_t din2usb_buf[DIN2USB_BUFSIZE];
static volatile uint8_t din2usb_w = 0;
static volatile uint8_t din2usb_r = 0;

void usbmidi_din_byte(uint8_t b) //from USART1 interrupt
{
	uint8_t next = (din2usb_w + 1) & (DIN2USB_BUFSIZE - 1);
	if (next != din2usb_r) //full - drop
	{
		din2usb_buf[din2usb_w] = b;
		din2usb_w = next;
	}
}

//byte stream to USB MIDI event packets: running status, realtime bytes inside messages
static uint8_t d2u_status = 0;
static uint8_t d2u_need = 0;
static uint8_t d2u_cnt = 0;
static uint8_t d2u_data[2];

static void din2usb_parse(uint8_t b)
{
	if (b >= 0xF8) //realtime, may appear anywhere
	{
		if (b != 0xFE)
		{
			uint8_t p[4] = {0x0F, b, 0, 0};
			tud_midi_packet_write(p);
		}
		return;
	}
	if (b & 0x80)
	{
		d2u_cnt = 0;
		if (b >= 0xF0) //sysex and system common are not forwarded, they also cancel running status
		{
			d2u_status = 0;
			return;
		}
		d2u_status = b;
		d2u_need = ((b & 0xE0) == 0xC0) ? 1 : 2; //program change, channel pressure have one data byte
		return;
	}
	if (!d2u_status)
		return;
	d2u_data[d2u_cnt++] = b;
	if (d2u_cnt == d2u_need)
	{
		uint8_t p[4] = {(uint8_t)(d2u_status >> 4), d2u_status, d2u_data[0], d2u_need == 2 ? d2u_data[1] : 0};
		tud_midi_packet_write(p);
		d2u_cnt = 0; //keep running status
	}
}

//////////////////////////////////////////////////////////////////////////////
// USB -> synth

static void usbmidi_dispatch(const uint8_t p[4])
{
	uint8_t cin = p[0] & 0x0F;
	uint8_t st = p[1];

	if (cin == 0x0F) //single byte: realtime
	{
		if (st == 0xF8)
			midiclock();
		else if (st == 0xFA)
			midistart();
		return;
	}
	if ((cin >= 0x04) && (cin <= 0x07)) //sysex start/continue (3 bytes), end with 1, 2 or 3 bytes
	{
		static const uint8_t sxlen[4] = {3, 1, 2, 3};
		sysex_rx(p + 1, sxlen[cin - 4]);
		return;
	}
	if ((cin < 0x08) || ((st & 0x0F) != midi_channel_switch)) //system common, other channels
		return;

	note_t note;
	note.note = p[2];
	note.velo = p[3];
	switch (st & 0xF0)
	{
	case 0x80:
		noteoff(note);
		break;
	case 0x90:
		if (p[3])
			noteon(note);
		else
			noteoff(note);
		break;
	case 0xB0:
		switch (p[2])
		{
		case 1:   //mod wheel msb, lsb
			pp_modwheel = (pp_modwheel & 0x007F) | (p[3] << 7);
			break;
		case 33:
			pp_modwheel = (pp_modwheel & 0x3F80) | p[3];
			break;
		case 2:   //breath msb, lsb
			lforam.nl2ahb_breath = (lforam.nl2ahb_breath & 0x007F) | (p[3] << 7);
			break;
		case 34:
			lforam.nl2ahb_breath = (lforam.nl2ahb_breath & 0x3F80) | p[3];
			break;
		case 64:  //sustain
			damper(p[3]);
			break;
		case 120: //all sound off, all notes off
		case 123:
			va_panic();
			break;
		}
		break;
	case 0xD0:
		pp_aftertouch = p[2];
		break;
	case 0xE0:
		pp_pitchwheel((int16_t)((p[3] << 7) | p[2]) - 0x2000);
		break;
	}
}

//////////////////////////////////////////////////////////////////////////////

void usbmidi_init(void)
{
	tud_init(0);
	NVIC_SetPriority(USB_IRQn, IRQ_PRIORITY_USB);
}

void usbmidi_irq(void)
{
	tud_int_handler(0);
}

//blocking send of a byte stream (sysex replies), gives up if the host stops reading
void usbmidi_send(const uint8_t* b, uint16_t len)
{
	uint32_t idle = 0;
	while (len && tud_midi_mounted() && (idle < 20000))
	{
		uint32_t n = tud_midi_stream_write(0, b, len);
		b += n;
		len -= n;
		if (n)
			idle = 0;
		else
		{
			idle++;
			tud_task();
		}
	}
}

//keeps the USB connection alive, safe to call from busy waits in the main context
void usbmidi_poll(void)
{
	tud_task();
}

void usbmidi_task(void)
{
	tud_task();

	uint8_t p[4];
	while (tud_midi_packet_read(p))
	{
		//mask only the interrupts that also feed the synth input queue, keep sr running
		uint32_t mask = (1UL << USART1_IRQn) | (1UL << TIM7_IRQn);
		uint32_t enabled = NVIC->ISER[0] & mask;
		NVIC->ICER[0] = mask;
		__DSB();
		__ISB();
		usbmidi_dispatch(p);
		NVIC->ISER[0] = enabled;
	}

	sysex_task(); //editor commands, may take a while (autotune)

	while (din2usb_r != din2usb_w)
	{
		uint8_t b = din2usb_buf[din2usb_r];
		din2usb_r = (din2usb_r + 1) & (DIN2USB_BUFSIZE - 1);
		if (tud_midi_mounted())
			din2usb_parse(b);
	}
}
