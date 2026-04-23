import { expect, test } from "bun:test";
import { sleepUntil } from "./sleepUntil.ts";

test("sleepUntil returns immediately for past target", async () => {
	const start = Date.now();
	await sleepUntil(new Date(start - 1000), { quiet: true });
	const elapsed = Date.now() - start;
	expect(elapsed).toBeLessThan(50);
});

test("sleepUntil waits until target time (~100ms)", async () => {
	const start = Date.now();
	await sleepUntil(new Date(start + 100), { quiet: true });
	const elapsed = Date.now() - start;
	expect(elapsed).toBeGreaterThanOrEqual(90);
	expect(elapsed).toBeLessThan(500);
});

test("sleepUntil calls onTick at least once", async () => {
	let ticks = 0;
	let lastRemaining = Number.POSITIVE_INFINITY;
	await sleepUntil(new Date(Date.now() + 150), {
		quiet: true,
		onTick: (remaining) => {
			ticks++;
			lastRemaining = remaining;
		},
	});
	expect(ticks).toBeGreaterThan(0);
	expect(lastRemaining).toBeGreaterThan(0);
});

test("sleepUntil with past date does not call onTick", async () => {
	let called = false;
	await sleepUntil(new Date(Date.now() - 1000), {
		quiet: true,
		onTick: () => {
			called = true;
		},
	});
	expect(called).toBe(false);
});
