#!/usr/bin/env node
/**
 * Generate build/icon.ico (Pokeball) without any image dependency.
 * Run: node tools/make-icon.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'build');
const SIZES = [256, 128, 64, 48, 32, 16];

/* ------------------------------- png encoder ------------------------------- */

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		const rowStart = y * (width * 4 + 1);
		raw[rowStart] = 0; // filter: none
		rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/* -------------------------------- renderer -------------------------------- */

const RED = [0xee, 0x15, 0x15];
const WHITE = [0xf7, 0xf7, 0xf7];
const BLACK = [0x1b, 0x1b, 0x1b];

// Returns [r,g,b,a] for a point in unit space (0..1), a in 0..1.
function shade(x, y) {
	const cx = 0.5;
	const cy = 0.5;
	const R = 0.47;
	const dx = x - cx;
	const dy = y - cy;
	const d = Math.hypot(dx, dy);
	if (d > R) return null;

	const stroke = R * 0.085;         // outer outline width
	const band = R * 0.095;           // horizontal band half-height
	const btnOuter = R * 0.30;
	const btnInner = R * 0.225;

	if (d > R - stroke) return BLACK;          // rim
	if (Math.abs(dy) < band) return BLACK;     // center band
	if (d < btnOuter) return d < btnInner ? WHITE : BLACK; // button
	return dy < 0 ? RED : WHITE;               // halves
}

function render(size) {
	const rgba = Buffer.alloc(size * size * 4);
	const SS = 4; // supersampling grid
	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const x = (px + (sx + 0.5) / SS) / size;
					const y = (py + (sy + 0.5) / SS) / size;
					const c = shade(x, y);
					if (!c) continue;
					r += c[0]; g += c[1]; b += c[2]; a += 1;
				}
			}
			const n = SS * SS;
			const idx = (py * size + px) * 4;
			if (a === 0) continue;
			rgba[idx] = Math.round(r / a);
			rgba[idx + 1] = Math.round(g / a);
			rgba[idx + 2] = Math.round(b / a);
			rgba[idx + 3] = Math.round((a / n) * 255);
		}
	}
	return rgba;
}

/* --------------------------------- ico wrap -------------------------------- */

function buildIco() {
	const images = SIZES.map(size => ({ size, png: encodePng(size, size, render(size)) }));
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(images.length, 4);

	let offset = 6 + images.length * 16;
	const entries = [];
	for (const img of images) {
		const entry = Buffer.alloc(16);
		entry[0] = img.size >= 256 ? 0 : img.size; // 0 = 256
		entry[1] = img.size >= 256 ? 0 : img.size;
		entry[2] = 0; // palette
		entry[3] = 0;
		entry.writeUInt16LE(1, 4);   // planes
		entry.writeUInt16LE(32, 6);  // bpp
		entry.writeUInt32LE(img.png.length, 8);
		entry.writeUInt32LE(offset, 12);
		offset += img.png.length;
		entries.push(entry);
	}
	return Buffer.concat([header, ...entries, ...images.map(i => i.png)]);
}

const ico = buildIco();
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
// PNG preview of the largest size, handy for eyeballing the artwork.
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePng(256, 256, render(256)));
console.log(`icon written: ${path.join(OUT_DIR, 'icon.ico')} (${ico.length} bytes)`);
