import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		// forks（子进程）而非 threads：pi-codemode 的 QuickJS 沙箱桥在 worker 嵌套线程里会挂起
		pool: "forks",
		hookTimeout: 30_000,
		testTimeout: 60_000,
	},
});
