import { describe, expect, mock, test } from "bun:test";
import { createLogger } from "./logger.ts";

describe("createLogger", () => {
	test("quiet logger suppresses info but still emits warn/error", () => {
		const stderr = mock(() => {});
		const logger = createLogger({ quiet: true, stderr });
		logger.info("hidden");
		expect(stderr).toHaveBeenCalledTimes(0);
		logger.warn("w");
		logger.error("e");
		expect(stderr).toHaveBeenCalledTimes(2);
		expect(stderr.mock.calls[0]?.[0]).toBe("w\n");
		expect(stderr.mock.calls[1]?.[0]).toBe("e\n");
	});

	test("non-quiet logger emits info via stderr writer with trailing newline", () => {
		const stderr = mock(() => {});
		const logger = createLogger({ quiet: false, stderr });
		logger.info("hello");
		expect(stderr).toHaveBeenCalledTimes(1);
		expect(stderr.mock.calls[0]?.[0]).toBe("hello\n");
	});

	test("preserves caller-supplied trailing newline", () => {
		const stderr = mock(() => {});
		const logger = createLogger({ stderr });
		logger.info("hi\n");
		expect(stderr.mock.calls[0]?.[0]).toBe("hi\n");
	});
});
