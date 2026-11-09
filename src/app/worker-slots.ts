/**
 * WorkerSlots 并发控制（SPEC §6.2）：
 * - 常规上限 MAX_WORKERS，新任务与后台唤醒必须排队等常规槽位；
 * - 额外 +1 人类紧急槽位：用户点审批卡片/回答追问/发消息唤醒已有任务时，常规槽全满也能立即执行；
 * - 常规槽释放时，唤醒已有任务的优先级高于启动新任务。
 */
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "worker-slots" });

export type SlotPriority = "human" | "background";
export type SlotKind = "new" | "wake";

type Waiter = {
	key: string;
	priority: SlotPriority;
	kind: SlotKind;
	resolve: () => void;
	queuedAt: number;
};

export class WorkerSlots {
	private used = 0;
	private readonly capacity: number;
	/** 紧急槽位持有人（同一时刻至多 1 个人类交互）。 */
	private emergencyHolder: string | null = null;
	private readonly waiters: Waiter[] = [];
	/** 观测指标。 */
	stats = { waitingHuman: 0, waitingWake: 0, waitingNew: 0, emergencyInUse: false };

	constructor(maxWorkers: number) {
		this.capacity = Math.max(1, maxWorkers);
	}

	get usedSlots(): number {
		return this.used;
	}

	/**
	 * 申请执行槽位。human 请求在常规槽全满且紧急槽空闲时立即占用 +1 紧急槽；
	 * background 请求排队等常规槽（唤醒已有任务优先于启动新任务）。
	 * 返回 release 函数（幂等）。
	 */
	async acquire(key: string, priority: SlotPriority, kind: SlotKind): Promise<() => void> {
		if (this.tryAdmit(key, priority, kind)) {
			return this.makeRelease(key);
		}
		await new Promise<void>((resolve) => {
			this.waiters.push({ key, priority, kind, resolve, queuedAt: Date.now() });
		});
		this.updateStats();
		return this.makeRelease(key);
	}

	private tryAdmit(key: string, priority: SlotPriority, kind: SlotKind): boolean {
		if (this.used < this.capacity) {
			this.used++;
			return true;
		}
		// 常规槽全满：只有人类交互可以立即占用 +1 紧急槽；后台一律排队
		if (priority === "human" && this.emergencyHolder === null) {
			this.emergencyHolder = key;
			this.used++;
			log.debug({ key, emergency: true }, "人类交互占用 +1 紧急槽位");
			this.updateStats();
			return true;
		}
		void kind;
		return false;
	}

	private makeRelease(key: string): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.release(key);
		};
	}

	private release(key: string): void {
		this.used = Math.max(0, this.used - 1);
		if (this.emergencyHolder === key) this.emergencyHolder = null;
		this.admitNext();
	}

	/** 常规槽空出时按优先级派发：wake（唤醒已有任务）> new（启动新任务）；等待中的人类请求也先给。 */
	private admitNext(): void {
		while (this.used < this.capacity) {
			const idx = this.pickWaiter();
			if (idx < 0) break;
			const [w] = this.waiters.splice(idx, 1);
			this.used++;
			w.resolve();
		}
		this.updateStats();
	}

	private pickWaiter(): number {
		if (this.waiters.length === 0) return -1;
		const human = this.waiters.findIndex((w) => w.priority === "human");
		if (human >= 0) return human;
		// 唤醒已有任务优先于启动新任务
		const wake = this.waiters.findIndex((w) => w.kind === "wake");
		if (wake >= 0) return wake;
		return 0;
	}

	private updateStats(): void {
		this.stats = {
			waitingHuman: this.waiters.filter((w) => w.priority === "human").length,
			waitingWake: this.waiters.filter((w) => w.priority === "background" && w.kind === "wake").length,
			waitingNew: this.waiters.filter((w) => w.priority === "background" && w.kind === "new").length,
			emergencyInUse: this.emergencyHolder !== null,
		};
	}

	/** 供重启恢复：直接占用 n 个槽位（活动任务数，上限为常规容量）。 */
	occupy(n: number): void {
		this.used = Math.min(this.capacity, this.used + n);
	}
}
