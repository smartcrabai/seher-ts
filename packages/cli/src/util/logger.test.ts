import { expect, spyOn, test } from "bun:test";
import { createLogger } from "./logger.ts";

test("quiet logger suppresses info", () => {
	const spy = spyOn(console, "error").mockImplementation(() => {});
	try {
		const logger = createLogger({ quiet: true });
		logger.info("hello");
		expect(spy).not.toHaveBeenCalled();
	} finally {
		spy.mockRestore();
	}
});

test("non-quiet logger emits info to stderr", () => {
	const spy = spyOn(console, "error").mockImplementation(() => {});
	try {
		const logger = createLogger({ quiet: false });
		logger.info("hello");
		expect(spy).toHaveBeenCalledWith("hello");
	} finally {
		spy.mockRestore();
	}
});

test("quiet logger still emits warn and error", () => {
	const spy = spyOn(console, "error").mockImplementation(() => {});
	try {
		const logger = createLogger({ quiet: true });
		logger.warn("w");
		logger.error("e");
		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy).toHaveBeenNthCalledWith(1, "w");
		expect(spy).toHaveBeenNthCalledWith(2, "e");
	} finally {
		spy.mockRestore();
	}
});

test("default options behave as non-quiet", () => {
	const spy = spyOn(console, "error").mockImplementation(() => {});
	try {
		const logger = createLogger();
		logger.info("x");
		expect(spy).toHaveBeenCalledWith("x");
	} finally {
		spy.mockRestore();
	}
});
