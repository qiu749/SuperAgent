/**
 * Computer Use 视觉桌面引擎驱动（SPEC-v3 §2.2-2.4 M9）：
 * - Set-of-Mark (SoM) 数字角标 + 多制式坐标双模定位：
 *   1) 优先用 macOS AXUIElement 辅助功能树提取可交互控件 (#1, #2...)，模型只需传 mark_id，100% 零像素漂移；
 *   2) 兜底支持千分比 [0, 1000]（Qwen Flash / UI-TARS）、归一化浮点 [0, 1] 与逻辑像素 1280x800（Claude 订阅）；
 * - 零 C++ 依赖的纯 Node.js (node:zlib) 红圈十字准星 PNG 合成器（drawCrosshairPng），用于高危点击前推企微/飞书审批；
 * - 64-bit 视觉哈希（computeVisualHash + hammingDistance），连续 3 步画面无变化自动触发手机远程接管。
 */
import { deflateSync, inflateSync } from "node:zlib";
import { execFile } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Button, clipboard, Key, keyboard, mouse, Point, screen, straightTo } from "@computer-use/nut-js";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "computer-env" });

export const DEFAULT_LOGICAL_WIDTH = 1280;
export const DEFAULT_LOGICAL_HEIGHT = 800;

export type ScreenSize = {
	physicalWidth: number;
	physicalHeight: number;
	logicalWidth: number;
	logicalHeight: number;
};

export type UiMarkElement = {
	markId: number;
	role: string;
	title: string;
	bounds: { x: number; y: number; width: number; height: number };
	centerX: number;
	centerY: number;
};

export type CoordSpace = "logical" | "1000" | "normalized";

export interface ComputerDriver {
	readonly kind: "macos-native" | "xvfb-docker" | "mock";
	getScreenSize(): Promise<ScreenSize>;
	screenshot(opts?: { withSoM?: boolean }): Promise<{
		pngBuffer: Buffer;
		annotatedPngBuffer?: Buffer;
		size: ScreenSize;
		marks: UiMarkElement[];
	}>;
	click(x: number, y: number, button?: "left" | "right" | "double"): Promise<void>;
	move(x: number, y: number): Promise<void>;
	drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
	type(text: string): Promise<void>;
	key(combo: string): Promise<void>;
	scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
	getRemoteTakeoverUrl?(sessionToken: string): string | undefined;
}

/** 高危点击关键词（命中时强制生成红圈十字准星截图并走企微/飞书审批）。 */
export const HIGH_RISK_GUI_RE = /(提交|发送|删除|支付|转账|确认打款|确认报销|群发|发布|清空|卸载|submit|delete|pay|transfer|send\s+all|publish)/i;

export function isHighRiskGuiIntent(text: string | undefined): boolean {
	if (!text) return false;
	return HIGH_RISK_GUI_RE.test(text);
}

/**
 * 将不同模型输出的坐标统一换算到逻辑空间 (logicalWidth x logicalHeight，默认 1280x800)：
 * - coordSpace === "1000"：Qwen Flash / Qwen-VL / UI-TARS 千分比 [0, 1000]
 * - coordSpace === "normalized" 或 (0 < x <= 1 && 0 < y <= 1)：[0.0, 1.0] 比例坐标
 * - coordSpace === "logical"（默认）：1280x800 逻辑像素
 */
export function normalizePointToLogical(
	x: number,
	y: number,
	coordSpace: CoordSpace | undefined,
	size: ScreenSize = { physicalWidth: 2560, physicalHeight: 1600, logicalWidth: DEFAULT_LOGICAL_WIDTH, logicalHeight: DEFAULT_LOGICAL_HEIGHT },
): { x: number; y: number } {
	const lw = size.logicalWidth || DEFAULT_LOGICAL_WIDTH;
	const lh = size.logicalHeight || DEFAULT_LOGICAL_HEIGHT;
	if (coordSpace === "normalized" || (coordSpace === undefined && x > 0 && x <= 1 && y > 0 && y <= 1)) {
		return {
			x: clamp(Math.round(x * lw), 0, lw - 1),
			y: clamp(Math.round(y * lh), 0, lh - 1),
		};
	}
	if (coordSpace === "1000") {
		return {
			x: clamp(Math.round((x / 1000) * lw), 0, lw - 1),
			y: clamp(Math.round((y / 1000) * lh), 0, lh - 1),
		};
	}
	return {
		x: clamp(Math.round(x), 0, lw - 1),
		y: clamp(Math.round(y), 0, lh - 1),
	};
}

/** 逻辑坐标 (1280x800) → 宿主机物理像素坐标（解决 Retina 2x 缩放漂移）。 */
export function logicalToPhysical(x: number, y: number, size: ScreenSize): { x: number; y: number } {
	const scaleX = size.physicalWidth / (size.logicalWidth || DEFAULT_LOGICAL_WIDTH);
	const scaleY = size.physicalHeight / (size.logicalHeight || DEFAULT_LOGICAL_HEIGHT);
	return {
		x: clamp(Math.round(x * scaleX), 0, size.physicalWidth - 1),
		y: clamp(Math.round(y * scaleY), 0, size.physicalHeight - 1),
	};
}

function clamp(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}

// ==================== 零依赖 PNG 编解码与红圈十字准星绘制 ====================

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c ^= buf[i]!;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "ascii");
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 生成一张指定宽高的纯色 RGBA PNG（用于测试或底板）。 */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth 8
	ihdr[9] = 6; // color type RGBA
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter type 0 (None)
		Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
	}
	const compressed = deflateSync(raw);
	return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), pngChunk("IDAT", compressed), pngChunk("IEND", Buffer.alloc(0))]);
}

/** 尝试解码简单 RGBA PNG（若原图是复杂滤镜的外部截图，则直接在缩略图画布上叠加准星）。 */
function tryDecodeSimpleRgbaPng(png: Buffer): { width: number; height: number; rgba: Uint8Array } | null {
	if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIG)) return null;
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	const bitDepth = png[24];
	const colorType = png[25];
	if (bitDepth !== 8 || colorType !== 6 || width > 4096 || height > 4096) return null;
	const idatParts: Buffer[] = [];
	let offset = 8;
	while (offset + 8 <= png.length) {
		const len = png.readUInt32BE(offset);
		const type = png.subarray(offset + 4, offset + 8).toString("ascii");
		const data = png.subarray(offset + 8, offset + 8 + len);
		if (type === "IDAT") idatParts.push(data);
		if (type === "IEND") break;
		offset += 12 + len;
	}
	if (idatParts.length === 0) return null;
	try {
		const raw = inflateSync(Buffer.concat(idatParts));
		const stride = width * 4;
		if (raw.length < (stride + 1) * height) return null;
		const rgba = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++) {
			if (raw[y * (stride + 1)] !== 0) return null;
			raw.copy(Buffer.from(rgba.buffer), y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
		}
		return { width, height, rgba };
	} catch {
		return null;
	}
}

/**
 * 在截图目标坐标 (targetX, targetY) 处绘制醒目的红色双圆环 + 十字准星（SPEC-v3 §2.3 红圈准星审批图）。
 * 若输入 PNG 为标准无滤镜 RGBA 则原地叠加；否则生成等比例准星示意画布。
 */
export function drawCrosshairPng(basePng: Buffer, targetX: number, targetY: number, logicalSize?: { width: number; height: number }): Buffer {
	const decoded = tryDecodeSimpleRgbaPng(basePng);
	const lWidth = logicalSize?.width ?? DEFAULT_LOGICAL_WIDTH;
	const lHeight = logicalSize?.height ?? DEFAULT_LOGICAL_HEIGHT;
	const width = decoded?.width ?? 320;
	const height = decoded?.height ?? 200;
	const rgba = decoded?.rgba ? new Uint8Array(decoded.rgba) : createGridCanvas(width, height);

	const cx = clamp(Math.round((targetX / lWidth) * width), 0, width - 1);
	const cy = clamp(Math.round((targetY / lHeight) * height), 0, height - 1);
	const outerR = Math.max(10, Math.round(Math.min(width, height) * 0.04));
	const innerR = Math.max(3, Math.round(outerR * 0.25));

	const setPixel = (px: number, py: number, r: number, g: number, b: number, a = 255) => {
		if (px < 0 || px >= width || py < 0 || py >= height) return;
		const idx = (py * width + px) * 4;
		rgba[idx] = r;
		rgba[idx + 1] = g;
		rgba[idx + 2] = b;
		rgba[idx + 3] = a;
	};

	// 绘制外红圈（线宽 3px）与中心实心红点
	for (let dy = -outerR - 3; dy <= outerR + 3; dy++) {
		for (let dx = -outerR - 3; dx <= outerR + 3; dx++) {
			const dist = Math.hypot(dx, dy);
			if (Math.abs(dist - outerR) <= 2.0 || dist <= innerR) {
				setPixel(cx + dx, cy + dy, 239, 68, 68, 255);
			}
		}
	}
	// 绘制十字准星线
	const crossLen = outerR + 8;
	for (let d = -crossLen; d <= crossLen; d++) {
		if (Math.abs(d) > innerR + 2) {
			setPixel(cx + d, cy, 239, 68, 68, 255);
			setPixel(cx + d, cy + 1, 255, 255, 255, 255);
			setPixel(cx, cy + d, 239, 68, 68, 255);
			setPixel(cx + 1, cy + d, 255, 255, 255, 255);
		}
	}
	return encodeRgbaPng(width, height, rgba);
}

function createGridCanvas(width: number, height: number): Uint8Array {
	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = (y * width + x) * 4;
			const isGrid = x % 32 === 0 || y % 32 === 0;
			const v = isGrid ? 226 : 244;
			rgba[idx] = v;
			rgba[idx + 1] = v;
			rgba[idx + 2] = v + 4;
			rgba[idx + 3] = 255;
		}
	}
	return rgba;
}

// ==================== 64-bit 视觉感知哈希（防连续 3 步无效点击死循环） ====================

/** 对截图 Buffer 计算 64-bit 视觉采样指纹（8x8 分桶均值哈希）。 */
export function computeVisualHash(buf: Buffer): bigint {
	if (buf.length === 0) return 0n;
	const buckets = new Float64Array(64);
	const counts = new Uint32Array(64);
	// 跳过固定头部，对全图数据均匀采样到 64 个空间桶
	const start = Math.min(32, buf.length);
	const len = buf.length - start;
	if (len <= 0) return 0n;
	for (let i = 0; i < len; i++) {
		const b = Math.min(63, Math.floor((i / len) * 64));
		buckets[b] += buf[start + i]!;
		counts[b] += 1;
	}
	let total = 0;
	for (let i = 0; i < 64; i++) {
		if (counts[i]! > 0) buckets[i] /= counts[i]!;
		total += buckets[i]!;
	}
	const mean = total / 64;
	let hash = 0n;
	for (let i = 0; i < 64; i++) {
		if (buckets[i]! >= mean) hash |= 1n << BigInt(i);
	}
	return hash;
}

/** 计算两个 64-bit 视觉指纹的汉明距离（0 表示画面完全相同）。 */
export function hammingDistance(a: bigint, b: bigint): number {
	let xor = a ^ b;
	let dist = 0;
	while (xor > 0n) {
		dist += Number(xor & 1n);
		xor >>= 1n;
	}
	return dist;
}

// ==================== 1. MockComputerDriver（单测与无桌面 CI 环境确定性驱动） ====================

export class MockComputerDriver implements ComputerDriver {
	readonly kind = "mock" as const;
	readonly actionsLog: { type: string; x?: number; y?: number; text?: string; key?: string; button?: string }[] = [];
	private marks: UiMarkElement[];
	private frameCounter = 0;
	/** 若设为 true，每次操作后画面保持完全不变（用于测试连续 3 步无变化熔断）。 */
	freezeScreen = false;

	constructor(marks?: UiMarkElement[]) {
		this.marks = marks ?? [
			{ markId: 1, role: "AXButton", title: "查询报表", bounds: { x: 180, y: 120, width: 100, height: 36 }, centerX: 230, centerY: 138 },
			{ markId: 2, role: "AXTextField", title: "搜索框", bounds: { x: 320, y: 120, width: 240, height: 36 }, centerX: 440, centerY: 138 },
			{ markId: 3, role: "AXButton", title: "确认提交报销", bounds: { x: 960, y: 680, width: 140, height: 44 }, centerX: 1030, centerY: 702 },
		];
	}

	setMarks(marks: UiMarkElement[]): void {
		this.marks = marks;
	}

	async getScreenSize(): Promise<ScreenSize> {
		return {
			physicalWidth: 2560,
			physicalHeight: 1600,
			logicalWidth: DEFAULT_LOGICAL_WIDTH,
			logicalHeight: DEFAULT_LOGICAL_HEIGHT,
		};
	}

	async screenshot(opts?: { withSoM?: boolean }): Promise<{
		pngBuffer: Buffer;
		annotatedPngBuffer?: Buffer;
		size: ScreenSize;
		marks: UiMarkElement[];
	}> {
		const size = await this.getScreenSize();
		const w = 160;
		const h = 100;
		const rgba = new Uint8Array(w * h * 4);
		const seed = this.freezeScreen ? 42 : (this.frameCounter + 1) * 37;
		for (let i = 0; i < w * h; i++) {
			rgba[i * 4] = (i + seed) & 0xff;
			rgba[i * 4 + 1] = ((i * 3) ^ seed) & 0xff;
			rgba[i * 4 + 2] = ((i * 7) + seed) & 0xff;
			rgba[i * 4 + 3] = 255;
		}
		const pngBuffer = encodeRgbaPng(w, h, rgba);
		const marks = opts?.withSoM === false ? [] : [...this.marks];
		return { pngBuffer, annotatedPngBuffer: pngBuffer, size, marks };
	}

	async click(x: number, y: number, button: "left" | "right" | "double" = "left"): Promise<void> {
		this.actionsLog.push({ type: "click", x, y, button });
		if (!this.freezeScreen) this.frameCounter++;
	}

	async move(x: number, y: number): Promise<void> {
		this.actionsLog.push({ type: "move", x, y });
	}

	async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
		this.actionsLog.push({ type: "drag", x: fromX, y: fromY, text: `${toX},${toY}` });
		if (!this.freezeScreen) this.frameCounter++;
	}

	async type(text: string): Promise<void> {
		this.actionsLog.push({ type: "type", text });
		if (!this.freezeScreen) this.frameCounter++;
	}

	async key(combo: string): Promise<void> {
		this.actionsLog.push({ type: "key", key: combo });
		if (!this.freezeScreen) this.frameCounter++;
	}

	async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
		this.actionsLog.push({ type: "scroll", x, y, text: `${deltaX},${deltaY}` });
		if (!this.freezeScreen) this.frameCounter++;
	}

	getRemoteTakeoverUrl(sessionToken: string): string {
		return `/computer-assist/${sessionToken}`;
	}
}

// ==================== 2. MacOsNativeComputerDriver（基于开源 @computer-use/nut-js + AXUIElement SoM） ====================

const NUT_KEY_MAP: Record<string, Key> = {
	return: Key.Return,
	enter: Key.Return,
	escape: Key.Escape,
	esc: Key.Escape,
	tab: Key.Tab,
	space: Key.Space,
	backspace: Key.Backspace,
	delete: Key.Delete,
	up: Key.Up,
	down: Key.Down,
	left: Key.Left,
	right: Key.Right,
	command: Key.LeftSuper,
	cmd: Key.LeftSuper,
	meta: Key.LeftSuper,
	super: Key.LeftSuper,
	control: Key.LeftControl,
	ctrl: Key.LeftControl,
	shift: Key.LeftShift,
	option: Key.LeftAlt,
	alt: Key.LeftAlt,
	a: Key.A,
	b: Key.B,
	c: Key.C,
	d: Key.D,
	e: Key.E,
	f: Key.F,
	g: Key.G,
	h: Key.H,
	i: Key.I,
	j: Key.J,
	k: Key.K,
	l: Key.L,
	m: Key.M,
	n: Key.N,
	o: Key.O,
	p: Key.P,
	q: Key.Q,
	r: Key.R,
	s: Key.S,
	t: Key.T,
	u: Key.U,
	v: Key.V,
	w: Key.W,
	x: Key.X,
	y: Key.Y,
	z: Key.Z,
};

export class MacOsNativeComputerDriver implements ComputerDriver {
	readonly kind = "macos-native" as const;
	private readonly fallbackMock = new MockComputerDriver();
	private cachedScreenPoints: { w: number; h: number } | null = null;

	constructor() {
		mouse.config.autoDelayMs = 40;
		keyboard.config.autoDelayMs = 20;
	}

	/**
	 * 获取屏幕尺寸：
	 * - physicalWidth/physicalHeight 对应 @computer-use/nut-js 硬件事件使用的 macOS 桌面逻辑点（如 1470x956），
	 *   避免把 Retina 2x 像素（2940x1912）传给 CGEvent 导致点击飞出屏幕右下角；
	 * - logicalWidth/logicalHeight 固定为 1280x800（与缩放后的截图 1:1 对齐）。
	 */
	async getScreenSize(): Promise<ScreenSize> {
		if (!this.cachedScreenPoints) {
			try {
				const [w, h] = await Promise.all([screen.width(), screen.height()]);
				if (w > 100 && h > 100) {
					this.cachedScreenPoints = { w, h };
				}
			} catch {
				// ignore and use fallback
			}
		}
		const pts = this.cachedScreenPoints ?? { w: 1470, h: 956 };
		return {
			physicalWidth: pts.w,
			physicalHeight: pts.h,
			logicalWidth: DEFAULT_LOGICAL_WIDTH,
			logicalHeight: DEFAULT_LOGICAL_HEIGHT,
		};
	}

	async screenshot(opts?: { withSoM?: boolean }): Promise<{
		pngBuffer: Buffer;
		annotatedPngBuffer?: Buffer;
		size: ScreenSize;
		marks: UiMarkElement[];
	}> {
		const size = await this.getScreenSize();
		const tmpFile = join(tmpdir(), `weagent-screen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
		try {
			await this.exec("/usr/sbin/screencapture", ["-x", "-t", "png", tmpFile]);
			if (existsSync(tmpFile)) {
				// 缩放到 1280x800：既满足多模态大模型 <=2000px 硬限制，又让模型看到的像素坐标与 1280x800 逻辑坐标 1:1 对齐
				await this.exec("/usr/bin/sips", ["-z", String(size.logicalHeight), String(size.logicalWidth), tmpFile], 4000).catch(() => {});
				const pngBuffer = readFileSync(tmpFile);
				unlinkSync(tmpFile);
				const marks = opts?.withSoM === false ? [] : await this.extractAxMarks(size);
				return { pngBuffer, annotatedPngBuffer: pngBuffer, size, marks };
			}
		} catch (err) {
			log.debug({ err }, "macOS screencapture 不可用（可能无屏幕录制权限），回退虚拟画布");
		} finally {
			try {
				if (existsSync(tmpFile)) unlinkSync(tmpFile);
			} catch {
				/* 忽略 */
			}
		}
		return this.fallbackMock.screenshot(opts);
	}

	/** 通过 JXA 读取前台应用窗口可点击控件树（坐标按真实桌面点换算到 1280x800 逻辑空间；失败时静默返回空数组）。 */
	private async extractAxMarks(size: ScreenSize): Promise<UiMarkElement[]> {
		const jxa = `
			const se = Application("System Events");
			const proc = se.processes.whose({ frontmost: true })[0];
			const win = proc.windows[0];
			const elems = win.entireContents();
			const out = [];
			for (let i = 0; i < Math.min(elems.length, 60); i++) {
				try {
					const role = elems[i].role();
					if (!["AXButton", "AXTextField", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXPopUpButton"].includes(role)) continue;
					const title = String(elems[i].title() || elems[i].description() || elems[i].value() || "").trim();
					if (!title) continue;
					const pos = elems[i].position();
					const sz = elems[i].size();
					if (sz[0] > 4 && sz[1] > 4) out.push({ role, title: title.slice(0, 40), x: pos[0], y: pos[1], w: sz[0], h: sz[1] });
				} catch (e) {}
				if (out.length >= 25) break;
			}
			JSON.stringify(out);
		`;
		try {
			const raw = await this.exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", jxa], 2500);
			const parsed = JSON.parse(raw.trim()) as { role: string; title: string; x: number; y: number; w: number; h: number }[];
			const scaleX = size.logicalWidth / size.physicalWidth;
			const scaleY = size.logicalHeight / size.physicalHeight;
			return parsed.map((item, idx) => {
				const bx = clamp(Math.round(item.x * scaleX), 0, size.logicalWidth - 1);
				const by = clamp(Math.round(item.y * scaleY), 0, size.logicalHeight - 1);
				const bw = Math.max(4, Math.round(item.w * scaleX));
				const bh = Math.max(4, Math.round(item.h * scaleY));
				return {
					markId: idx + 1,
					role: item.role,
					title: item.title,
					bounds: { x: bx, y: by, width: bw, height: bh },
					centerX: clamp(Math.round(bx + bw / 2), 0, size.logicalWidth - 1),
					centerY: clamp(Math.round(by + bh / 2), 0, size.logicalHeight - 1),
				};
			});
		} catch {
			return [];
		}
	}

	async click(x: number, y: number, button: "left" | "right" | "double" = "left"): Promise<void> {
		const target = new Point(Math.round(x), Math.round(y));
		await mouse.setPosition(target);
		if (button === "double") {
			await mouse.doubleClick(Button.LEFT);
		} else if (button === "right") {
			await mouse.click(Button.RIGHT);
		} else {
			await mouse.click(Button.LEFT);
		}
	}

	async move(x: number, y: number): Promise<void> {
		await mouse.setPosition(new Point(Math.round(x), Math.round(y)));
	}

	async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
		await mouse.setPosition(new Point(Math.round(fromX), Math.round(fromY)));
		await mouse.drag(straightTo(new Point(Math.round(toX), Math.round(toY))));
	}

	/**
	 * 文本输入（参考 UI-TARS operator-nut-js 实现）：
	 * 通过系统剪贴板写入 UTF-8 文本 + @computer-use/nut-js 发送 Cmd+V 粘贴，
	 * 完美支持中文（如「熊喵喵」「我爱你宝宝」）、Emoji 与长文本，避免 keystroke ASCII 乱码。
	 */
	async type(text: string): Promise<void> {
		await clipboard.setContent(text);
		await keyboard.pressKey(Key.LeftSuper, Key.V);
		await keyboard.releaseKey(Key.LeftSuper, Key.V);
	}

	async key(combo: string): Promise<void> {
		const parts = combo
			.split("+")
			.map((p) => p.trim().toLowerCase())
			.filter(Boolean);
		const keys = parts.map((p) => NUT_KEY_MAP[p]).filter((k): k is Key => k !== undefined);
		if (keys.length === 0) {
			await keyboard.type(combo);
			return;
		}
		await keyboard.pressKey(...keys);
		await keyboard.releaseKey(...keys);
	}

	async scroll(x: number, y: number, _deltaX: number, deltaY: number): Promise<void> {
		await mouse.setPosition(new Point(Math.round(x), Math.round(y)));
		const amount = Math.max(1, Math.min(800, Math.abs(Math.round(deltaY))));
		if (deltaY >= 0) {
			await mouse.scrollDown(amount);
		} else {
			await mouse.scrollUp(amount);
		}
	}

	getRemoteTakeoverUrl(sessionToken: string): string {
		return `/computer-assist/${sessionToken}`;
	}

	private exec(cmd: string, args: string[], timeout = 5000): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(cmd, args, { timeout }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
		});
	}
}

export function createComputerDriver(kind: "macos-native" | "xvfb-docker" | "mock"): ComputerDriver {
	if (kind === "mock") return new MockComputerDriver();
	return new MacOsNativeComputerDriver();
}
