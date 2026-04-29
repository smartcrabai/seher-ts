export interface SleepUntilOptions {
	quiet?: boolean;
	label?: string;
	onTick?: (remainingMs: number) => void;
	signal?: AbortSignal;
}

function formatHms(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export async function sleepUntil(
	target: Date,
	opts: SleepUntilOptions = {},
): Promise<void> {
	const { quiet = false, label = "sleep", onTick, signal } = opts;
	const targetMs = target.getTime();

	if (targetMs <= Date.now()) {
		return;
	}

	const write = (s: string) => {
		process.stderr.write(s);
	};

	try {
		while (true) {
			if (signal?.aborted) return;
			const remaining = targetMs - Date.now();
			if (remaining <= 0) break;

			onTick?.(remaining);
			if (!quiet) {
				write(`\r[${label}] resets in ${formatHms(remaining)}`);
			}

			const step = Math.min(remaining, 1000);
			await new Promise<void>((resolve) => setTimeout(resolve, step));
		}
	} finally {
		if (!quiet) {
			write("\n");
		}
	}
}
