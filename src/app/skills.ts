/**
 * Hermes 式程序性技能库（SPEC-v2 §8 M7）：
 * - 目录布局 /data/skills/[category/]<name>/SKILL.md + references/templates/scripts/assets；
 * - .locks/ 单技能哈希文件锁（批量操作按名字典序加锁防死锁）、.curator_ledger.jsonl 追加审计、
 *   .curator_backups/blobs/ SHA-256 内容寻址快照（一键回滚）、.archive/ 可恢复归档（绝不物理删除）；
 * - 四道守卫：先读后写、正则安全扫描（dangerous 自动回滚）、ledger+blobs、pinned/归档保护；
 * - skills-index：目录 mtime 签名缓存（30s TTL），只注入 name + 一句话 description。
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { load as loadYaml } from "js-yaml";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "skills" });

const SKILL_FILE = "SKILL.md";
export const ALLOWED_SUBDIRS = ["references", "templates", "scripts", "assets"] as const;
const NAME_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME_LEN = 64;
const MAX_BODY_CHARS = 100_000;
const MAX_SUPPORT_FILE_BYTES = 1024 * 1024;
const INDEX_TTL_MS = 30_000;
const DESC_TRIGGER_PREFIX = "Use when ";

export type SkillMeta = {
	/** 相对 root 的技能标识（可含一级 category 前缀，如 "writing/weekly-report"）。 */
	name: string;
	description: string;
	category: string;
	pinned: boolean;
	path: string;
};

export type SkillOp =
	| { name: string; action: "create"; content: string; category?: string }
	| { name: string; action: "patch"; old_string?: string; new_string?: string; replace_all?: boolean; content?: string; file_path?: string }
	| { name: string; action: "write_file"; file_path: string; content: string }
	| { name: string; action: "remove_file"; file_path: string }
	| { name: string; action: "delete"; absorbed_into?: string };

export type LedgerEntry = {
	id: string;
	ts: number;
	actor: "curator" | "agent" | "user";
	action: string;
	skill: string;
	before_manifest: Record<string, string>;
	after_manifest: Record<string, string>;
	evidence: string;
};

// ---------- 安全扫描（skills_guard，SPEC-v2 §8.4 守卫 2） ----------

const EXFIL_RES: RegExp[] = [
	// 脚本/代码把数据发往外部 URL
	/\b(curl|wget|fetch\s*\(|axios[.(]|requests\.(post|get|put)|http\.client|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]{0,160}https?:\/\//i,
	// URL 查询串携带疑似敏感数据（token/key/secret/env/context）
	/https?:\/\/[^\s"'`]{4,}\?[^\s"'`]*(token|api[_-]?key|secret|password|context|transcript|env)/i,
];
const PERSIST_RES: RegExp[] = [
	/\b(AGENTS\.md|CLAUDE\.md|\.zshrc|\.bashrc|\.profile|crontab|authorized_keys|LaunchAgents)\b/,
	/(写入|修改|追加)\s*[`"']?\.env\b/,
];
const DESTRUCTIVE_RES: RegExp[] = [
	/\brm\s+-rf\s+(?:\/(?:\s|$)|~|\$HOME)/,
	/\bmkfs\b/i,
	/\bdd\s+if=[^\n]*of=\/dev\//,
	/:\(\)\{\s*:\|:&\s*\};:/,
	/\bchmod\s+-R\s+777\s+\//,
	/\b(shutdown|reboot)\b/i,
];

export type ScanVerdict = { level: "clean" | "warn" | "dangerous"; findings: string[] };

/** 静态安全扫描：exfiltration / persistence / 破坏性 shell。scripts 与代码块中的 persistence 才算 dangerous。 */
export function scanContent(content: string, filePath: string): ScanVerdict {
	const findings: string[] = [];
	let level: ScanVerdict["level"] = "clean";
	const isScript = filePath.startsWith("scripts/") || filePath.endsWith(".sh") || filePath.endsWith(".py") || filePath.endsWith(".js") || filePath.endsWith(".ts");
	const codeBlocks = [...content.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join("\n");
	const scanTargets: [string, string, boolean][] = [
		["全量", content, true],
		["代码块", codeBlocks, true],
	];
	for (const [label, text, _all] of scanTargets) {
		for (const re of EXFIL_RES) {
			const m = re.exec(text);
			if (m) {
				findings.push(`exfiltration(${label}): ${m[0].slice(0, 120)}`);
				level = "dangerous";
			}
		}
		for (const re of DESTRUCTIVE_RES) {
			const m = re.exec(text);
			if (m) {
				findings.push(`destructive(${label}): ${m[0].slice(0, 120)}`);
				level = "dangerous";
			}
		}
	}
	const persistenceTarget = isScript ? content : codeBlocks;
	for (const re of PERSIST_RES) {
		const m = re.exec(persistenceTarget);
		if (m) {
			findings.push(`persistence: ${m[0].slice(0, 120)}`);
			level = "dangerous";
		}
	}
	return { level, findings };
}

// ---------- frontmatter ----------

export type SkillFrontmatter = { name: string; description: string; category?: string; pinned?: boolean };

export function parseFrontmatter(content: string): SkillFrontmatter | null {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
	if (!m) return null;
	try {
		const data = loadYaml(m[1]) as Record<string, unknown> | null;
		if (!data || typeof data !== "object") return null;
		return {
			name: String(data.name ?? ""),
			description: String(data.description ?? ""),
			category: data.category === undefined ? undefined : String(data.category),
			pinned: data.pinned === true,
		};
	} catch {
		return null;
	}
}

function buildFrontmatter(meta: SkillFrontmatter): string {
	const lines = ["---", `name: ${meta.name}`, `description: ${meta.description}`];
	if (meta.category) lines.push(`category: ${meta.category}`);
	lines.push("---", "");
	return lines.join("\n");
}

// ---------- SkillStore ----------

export class SkillStore {
	/** 当前批持锁文件（同批一次性加解锁）。 */
	private lockedPaths: string[] = [];

	constructor(readonly root: string) {
		mkdirSync(join(root, ".locks"), { recursive: true });
		mkdirSync(join(root, ".curator_backups", "blobs"), { recursive: true });
		mkdirSync(join(root, ".archive"), { recursive: true });
	}

	private get ledgerPath(): string {
		return join(this.root, ".curator_ledger.jsonl");
	}

	private get blobsDir(): string {
		return join(this.root, ".curator_backups", "blobs");
	}

	/** 技能名 → 目录（支持一级 category 前缀）；拒绝穿越与非法字符。 */
	resolveSkillDir(name: string): string {
		const clean = name.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
		if (!clean) throw new Error("技能名不能为空");
		const segments = clean.split("/");
		if (segments.length > 2) throw new Error(`技能名最多一层 category 前缀：${name}`);
		for (const seg of segments) {
			if (!NAME_SEGMENT_RE.test(seg)) throw new Error(`技能名段非法（需 ${NAME_SEGMENT_RE.source}）：${seg}`);
			if (seg.length > MAX_NAME_LEN) throw new Error(`技能名段超长（≤${MAX_NAME_LEN}）：${seg}`);
		}
		const dir = join(this.root, ...segments);
		const rel = relative(this.root, dir);
		if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`技能路径越界：${name}`);
		return dir;
	}

	/** 解析技能内支持文件路径（references/templates/scripts/assets 四个允许子目录）。 */
	private resolveSupportPath(skillDir: string, filePath: string): string {
		const clean = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
		if (clean.includes("..") || isAbsolute(filePath)) throw new Error(`支持文件路径非法（拒绝 .. 与绝对路径）：${filePath}`);
		const top = clean.split("/")[0];
		if (!(ALLOWED_SUBDIRS as readonly string[]).includes(top)) {
			throw new Error(`支持文件必须在 ${ALLOWED_SUBDIRS.join("/")} 之一内：${filePath}`);
		}
		const abs = resolve(skillDir, clean);
		if (relative(skillDir, abs).startsWith("..")) throw new Error(`支持文件路径越界：${filePath}`);
		return abs;
	}

	listSkills(): SkillMeta[] {
		const out: SkillMeta[] = [];
		const walk = (dir: string, prefix: string, depth: number) => {
			let entries: string[];
			try {
				entries = readdirSync(dir);
			} catch {
				return;
			}
			for (const entry of entries) {
				if (entry.startsWith(".")) continue;
				const full = join(dir, entry);
				let st;
				try {
					st = statSync(full);
				} catch {
					continue;
				}
				if (!st.isDirectory()) continue;
				const skillFile = join(full, SKILL_FILE);
				if (existsSync(skillFile)) {
					try {
						const fm = parseFrontmatter(readFileSync(skillFile, "utf8"));
						if (fm?.description) {
							out.push({
								name: prefix + entry,
								description: fm.description,
								category: fm.category ?? prefix.replace(/\/$/, ""),
								pinned: fm.pinned === true,
								path: skillFile,
							});
						}
					} catch (err) {
						log.warn({ skill: entry, err }, "SKILL.md 解析失败，跳过");
					}
				} else if (depth === 0) {
					walk(full, `${entry}/`, depth + 1);
				}
			}
		};
		walk(this.root, "", 0);
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	private indexCache: { signature: string; text: string; at: number } | null = null;

	/** skills-index section 文本（mtime 签名缓存 30s TTL）。 */
	renderIndex(): string | undefined {
		const skills = this.listSkills();
		if (skills.length === 0) return undefined;
		const signature = this.indexSignature();
		if (this.indexCache && this.indexCache.signature === signature && Date.now() - this.indexCache.at < INDEX_TTL_MS) {
			return this.indexCache.text;
		}
		const text = ["可用技能索引（用 skill_view 按需加载全文，禁止臆测其内容）：", ...skills.map((s) => `- ${s.name}：${s.description}`)].join("\n");
		this.indexCache = { signature, text, at: Date.now() };
		return text;
	}

	private indexSignature(): string {
		const parts: string[] = [];
		const sig = (dir: string) => {
			try {
				parts.push(`${dir}:${statSync(dir).mtimeMs}`);
			} catch {
				/* 忽略 */
			}
		};
		sig(this.root);
		for (const s of this.listSkills()) sig(dirname(s.path));
		return parts.join("|");
	}

	/** 读取 SKILL.md 或支持文件（带路径穿越防护）。返回真实路径供先读后写登记。 */
	view(name: string, filePath?: string): { path: string; content: string } {
		const dir = this.resolveSkillDir(name);
		if (!existsSync(join(dir, SKILL_FILE))) throw new Error(`技能 ${name} 不存在（没有 ${SKILL_FILE}）`);
		if (!filePath) return { path: join(dir, SKILL_FILE), content: readFileSync(join(dir, SKILL_FILE), "utf8") };
		const abs = this.resolveSupportPath(dir, filePath);
		if (!existsSync(abs)) throw new Error(`技能 ${name} 下不存在文件 ${filePath}`);
		return { path: abs, content: readFileSync(abs, "utf8") };
	}

	// ---------- ledger & blobs ----------

	private readLedger(): LedgerEntry[] {
		if (!existsSync(this.ledgerPath)) return [];
		return readFileSync(this.ledgerPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as LedgerEntry);
	}

	private appendLedger(entry: LedgerEntry): void {
		writeFileSync(this.ledgerPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
	}

	/** 指定技能最近一次可回滚的 ledger 条目（H5 面板「一键回滚」用；无则 null）。 */
	latestLedgerEntryFor(skill: string): LedgerEntry | null {
		const entries = this.readLedger().filter((e) => e.skill === skill && e.action !== "rollback");
		return entries.length > 0 ? entries[entries.length - 1]! : null;
	}

	private sha256(buf: Buffer | string): string {
		return createHash("sha256").update(buf).digest("hex");
	}

	/** 技能目录快照：relPath → sha256（忽略 node_modules/.venv/.git 等临时目录）。 */
	private manifest(skillDir: string): Record<string, string> {
		const out: Record<string, string> = {};
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				if (entry === "node_modules" || entry === ".venv" || entry === ".git") continue;
				const full = join(dir, entry);
				const st = statSync(full);
				if (st.isDirectory()) walk(full);
				else out[relative(skillDir, full).split(sep).join("/")] = this.sha256(readFileSync(full));
			}
		};
		try {
			walk(skillDir);
		} catch {
			/* 目录不存在 → 空清单 */
		}
		return out;
	}

	private snapshotContents(skillDir: string): Map<string, Buffer> {
		const snap = new Map<string, Buffer>();
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				if (entry === "node_modules" || entry === ".venv" || entry === ".git") continue;
				const full = join(dir, entry);
				const st = statSync(full);
				if (st.isDirectory()) walk(full);
				else snap.set(relative(skillDir, full).split(sep).join("/"), readFileSync(full));
			}
		};
		if (existsSync(skillDir)) walk(skillDir);
		return snap;
	}

	private saveBlob(content: Buffer): string {
		const hash = this.sha256(content);
		const path = join(this.blobsDir, hash);
		if (!existsSync(path)) writeFileSync(path, content);
		return hash;
	}

	private restoreSnapshot(skillDir: string, snap: Map<string, Buffer>): void {
		// 删除快照之后新增的文件，再恢复快照内容
		if (existsSync(skillDir)) {
			for (const rel of Object.keys(this.manifest(skillDir))) {
				if (!snap.has(rel)) {
					try {
						unlinkSync(join(skillDir, rel));
					} catch {
						/* 忽略 */
					}
				}
			}
		}
		for (const [rel, buf] of snap) {
			const abs = join(skillDir, rel);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, buf);
		}
	}

	// ---------- 原子批量操作 ----------

	/**
	 * 按序执行 operations（任一步失败整批回滚）。requireReadPaths 非空时执行"先读后写"守卫
	 * （后台复盘上下文必须先 skill_view 过目标文件）。
	 */
	async manage(
		operations: SkillOp[],
		opts: { actor: LedgerEntry["actor"]; userId?: string; requireReadPaths?: Set<string>; onSkillUpsert?: (name: string, meta: SkillFrontmatter) => void },
	): Promise<{ results: string[]; ledgerIds: string[] }> {
		if (operations.length === 0) throw new Error("operations 不能为空");
		// 字典序互斥锁（防死锁）
		const names = [...new Set(operations.map((o) => o.name))].sort();
		const locks = names;
		try {
			this.acquireLocks(locks);
			const results: string[] = [];
			const ledgerIds: string[] = [];
			// 预快照：涉及的所有技能目录
			const snaps = new Map<string, Map<string, Buffer>>();
			const manifestsBefore = new Map<string, Record<string, string>>();
			for (const name of names) {
				const dir = this.resolveSkillDir(name);
				snaps.set(dir, this.snapshotContents(dir));
				manifestsBefore.set(dir, this.manifest(dir));
			}
			try {
				for (const op of operations) {
					const r = this.applyOp(op, opts);
					results.push(r);
				}
			} catch (err) {
				// 整批原子回滚
				for (const [dir, snap] of snaps) this.restoreSnapshot(dir, snap);
				throw err;
			}
			// 成功：逐 op 写 ledger（含前后清单）
			for (const op of operations) {
				const dir = this.resolveSkillDir(op.name);
				const after = this.manifest(dir);
				const before = manifestsBefore.get(dir)!;
				const entry: LedgerEntry = {
					id: `lg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
					ts: Date.now(),
					actor: opts.actor,
					action: op.action,
					skill: op.name,
					before_manifest: before,
					after_manifest: after,
					evidence: describeOp(op),
				};
				this.appendLedger(entry);
				ledgerIds.push(entry.id);
			}
			if (opts.onSkillUpsert) {
				for (const name of names) {
					const dir = this.resolveSkillDir(name);
					const skillFile = join(dir, SKILL_FILE);
					if (existsSync(skillFile)) {
						const fm = parseFrontmatter(readFileSync(skillFile, "utf8"));
						if (fm?.description) opts.onSkillUpsert(name, fm);
					}
				}
			}
			return { results, ledgerIds };
		} finally {
			this.releaseLocks(locks);
		}
	}

	private applyOp(op: SkillOp, opts: { actor: LedgerEntry["actor"]; userId?: string; requireReadPaths?: Set<string>; onSkillUpsert?: (name: string, meta: SkillFrontmatter) => void }): string {
		const dir = this.resolveSkillDir(op.name);
		const skillFile = join(dir, SKILL_FILE);
		const guardRead = (absPath: string) => {
			if (!opts.requireReadPaths) return;
			if (!opts.requireReadPaths.has(absPath)) {
				throw new Error(`先读后写守卫：写 ${op.name} 前必须先在本次复盘中 skill_view 该文件（${absPath}）。请先读取再重试。`);
			}
		};
		const guardScan = (content: string, filePath: string) => {
			const verdict = scanContent(content, filePath);
			if (verdict.level === "dangerous") {
				throw new Error(`安全扫描（skills_guard）拦截 dangerous 内容，已回滚本次写入：\n${verdict.findings.join("\n")}\n请剔除危险内容后重试。`);
			}
		};
		const savePreImage = (absPath: string) => {
			if (existsSync(absPath)) this.saveBlob(readFileSync(absPath));
		};

		switch (op.action) {
			case "create": {
				if (existsSync(skillFile)) throw new Error(`技能 ${op.name} 已存在（用 patch 修改）`);
				if (op.content.length > MAX_BODY_CHARS) throw new Error(`SKILL.md 正文超限（>${MAX_BODY_CHARS} 字符）`);
				const body = op.content.startsWith("---") ? op.content : `${buildFrontmatter({ name: op.name.split("/").pop()!, description: "", category: op.category })}\n${op.content}`;
				const fm = parseFrontmatter(body);
				if (!fm) throw new Error("create 内容缺少合法的 YAML frontmatter（--- 包裹）");
				if (!fm.description.startsWith(DESC_TRIGGER_PREFIX)) {
					throw new Error(`description 必须以 "${DESC_TRIGGER_PREFIX}<触发条件>. <一句话行为>." 开头（自包含触发器）`);
				}
				if (fm.description.length > 400) throw new Error("description 过长（≤400 字符）");
				guardScan(op.content, SKILL_FILE);
				mkdirSync(dir, { recursive: true });
				writeFileSync(skillFile, body);
				return `created ${op.name}`;
			}
			case "patch": {
				const target = op.file_path ? this.resolveSupportPath(dir, op.file_path) : skillFile;
				if (!existsSync(target)) throw new Error(`patch 目标不存在：${op.file_path ?? SKILL_FILE}（技能 ${op.name}）`);
				guardRead(target);
				savePreImage(target);
				const before = readFileSync(target, "utf8");
				let after: string;
				if (op.content !== undefined) {
					// 全文重写兜底
					if (op.content.length > MAX_BODY_CHARS) throw new Error(`重写内容超限（>${MAX_BODY_CHARS} 字符）`);
					after = op.content;
					if (target === skillFile) {
						const fm = parseFrontmatter(after);
						if (!fm) throw new Error("SKILL.md 重写后必须保留合法 YAML frontmatter");
					}
				} else {
					if (op.old_string === undefined || op.new_string === undefined) throw new Error("patch 需要 old_string/new_string 或 content");
					if (!before.includes(op.old_string)) throw new Error(`old_string 未命中（${op.file_path ?? SKILL_FILE}），请先 skill_view 获取最新全文再精准替换`);
					after = op.replace_all ? before.split(op.old_string).join(op.new_string) : before.replace(op.old_string, op.new_string);
				}
				guardScan(after, relative(dir, target).split(sep).join("/"));
				writeFileSync(target, after);
				return `patched ${op.name}${op.file_path ? `/${op.file_path}` : ""}`;
			}
			case "write_file": {
				const target = this.resolveSupportPath(dir, op.file_path);
				if (op.content.length > MAX_SUPPORT_FILE_BYTES) throw new Error(`支持文件超限（>${MAX_SUPPORT_FILE_BYTES} 字节）：${op.file_path}`);
				if (existsSync(target)) guardRead(target);
				guardScan(op.content, op.file_path);
				mkdirSync(dirname(target), { recursive: true });
				savePreImage(target);
				writeFileSync(target, op.content);
				return `wrote ${op.name}/${op.file_path}`;
			}
			case "remove_file": {
				const target = this.resolveSupportPath(dir, op.file_path);
				if (!existsSync(target)) throw new Error(`remove_file 目标不存在：${op.file_path}`);
				guardRead(target);
				savePreImage(target);
				unlinkSync(target);
				return `removed ${op.name}/${op.file_path}`;
			}
			case "delete": {
				if (!existsSync(skillFile)) throw new Error(`技能 ${op.name} 不存在`);
				const meta = this.listSkills().find((s) => s.name === op.name);
				if (meta?.pinned) throw new Error(`技能 ${op.name} 被用户固定（pinned），禁止删除`);
				if (op.absorbed_into) {
					const targetDir = this.resolveSkillDir(op.absorbed_into);
					if (!existsSync(join(targetDir, SKILL_FILE))) throw new Error(`absorbed_into 指向的技能 ${op.absorbed_into} 不存在`);
				} else {
					// 归档保护：后台复盘严禁无 absorbed_into 的裸删除
					if (opts.actor === "curator") throw new Error(`后台复盘删除技能必须提供 absorbed_into（合并目标）`);
				}
				const archived = join(this.root, ".archive", `${op.name.replace("/", "_")}-${Date.now()}`);
				mkdirSync(dirname(archived), { recursive: true });
				renameSync(dir, archived);
				return `archived ${op.name} → ${basename(archived)}${op.absorbed_into ? `（并入 ${op.absorbed_into}）` : ""}`;
			}
			default: {
				throw new Error(`未知操作：${JSON.stringify(op)}`);
			}
		}
	}

	// ---------- 回滚（/skills rollback <entry_id>） ----------

	async rollback(entryId: string): Promise<string> {
		const entries = this.readLedger();
		const idx = entries.findIndex((e) => e.id === entryId);
		if (idx < 0) throw new Error(`ledger 中没有 ${entryId}`);
		const entry = entries[idx];
		const dir = this.resolveSkillDir(entry.skill);
		// 恢复 before_manifest：从 blobs 取回每个文件的修改前内容
		const before = entry.before_manifest;
		const after = entry.after_manifest;
		for (const rel of Object.keys(after)) {
			if (!(rel in before)) {
				try {
					unlinkSync(join(dir, rel));
				} catch {
					/* 忽略 */
				}
			}
		}
		for (const [rel, hash] of Object.entries(before)) {
			const blob = join(this.blobsDir, hash);
			if (!existsSync(blob)) throw new Error(`blob 缺失（${hash}），无法回滚 ${entry.skill}/${rel}`);
			const abs = join(dir, rel);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, readFileSync(blob));
		}
		const rollbackEntry: LedgerEntry = {
			id: `lg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			ts: Date.now(),
			actor: "user",
			action: "rollback",
			skill: entry.skill,
			before_manifest: after,
			after_manifest: before,
			evidence: `rollback of ${entryId}`,
		};
		this.appendLedger(rollbackEntry);
		this.indexCache = null;
		return `已把 ${entry.skill} 回滚到 ${entryId} 之前的状态`;
	}

	// ---------- 文件锁 ----------

	private lockPath(name: string): string {
		return join(this.root, ".locks", `${this.sha256(name).slice(0, 24)}.lock`);
	}

	private acquireLocks(names: string[]): void {
		const deadline = Date.now() + 5_000;
		const held: string[] = [];
		const fds: number[] = [];
		try {
			for (const name of names) {
				const path = this.lockPath(name);
				for (;;) {
					try {
						const fd = openSync(path, "wx");
						fds.push(fd);
						held.push(path);
						break;
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
						if (Date.now() > deadline) throw new Error(`技能锁获取超时：${name}（可能有并发 curator 操作）`);
						Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
					}
				}
			}
			this.lockedPaths = held;
		} catch (err) {
			for (const fd of fds) {
				try {
					closeSync(fd);
				} catch {
					/* 忽略 */
				}
			}
			for (const p of held) {
				try {
					unlinkSync(p);
				} catch {
					/* 忽略 */
				}
			}
			throw err;
		}
	}

	private releaseLocks(_names: string[]): void {
		for (const p of this.lockedPaths) {
			try {
				unlinkSync(p);
			} catch {
				/* 忽略 */
			}
		}
		this.lockedPaths = [];
	}

	/** 清理孤儿锁文件（进程崩溃残留；启动时调用）。 */
	cleanupOrphanLocks(): void {
		try {
			for (const f of readdirSync(join(this.root, ".locks"))) {
				try {
					unlinkSync(join(this.root, ".locks", f));
				} catch {
					/* 忽略 */
				}
			}
		} catch {
			/* 忽略 */
		}
	}
}

function describeOp(op: SkillOp): string {
	switch (op.action) {
		case "create":
			return `create ${op.name}（${op.content.length} 字符）`;
		case "patch":
			return op.content !== undefined ? `rewrite ${op.name}${op.file_path ? `/${op.file_path}` : ""}` : `patch ${op.name}${op.file_path ? `/${op.file_path}` : ""}（${(op.old_string ?? "").length}→${(op.new_string ?? "").length} 字符）`;
		case "write_file":
			return `write_file ${op.name}/${op.file_path}（${op.content.length} 字符）`;
		case "remove_file":
			return `remove_file ${op.name}/${op.file_path}`;
		case "delete":
			return `delete ${op.name}${op.absorbed_into ? ` absorbed_into=${op.absorbed_into}` : ""}`;
	}
}
