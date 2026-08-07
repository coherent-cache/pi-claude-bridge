/**
 * Regression tests for the pi-session -> Claude Code session mapping.
 *
 * Without persistence, resuming a pi conversation lost the mapping and REBUILD
 * minted a fresh Claude Code session id holding the whole history, orphaning the
 * previous file in ~/.claude/projects. One orphan per resume, each a growing
 * copy of the same conversation — observed at 10 files for a single five-day
 * conversation before this was fixed.
 */
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { __test } = await import("../src/index.js");
const { lookupMapping, recordMapping, dropMapping, clearMappings } = await import("../src/session-map.js");

const PI_SESSION = "pi-session-0001";
const CC_SESSION = "22222222-2222-4222-8222-222222222222";

let agentDir;
let prevAgentDir;

beforeEach(() => {
	// getAgentDir() honours PI_AGENT_DIR, so the map lands in a throwaway
	// directory rather than the developer's real ~/.pi/agent.
	agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-map-"));
	prevAgentDir = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	clearMappings();
});

afterEach(() => {
	__test.resetSharedSession();
	__test.setPiSessionId(null);
	if (prevAgentDir === undefined) delete process.env.PI_AGENT_DIR;
	else process.env.PI_AGENT_DIR = prevAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

describe("session map", () => {
	it("round-trips a mapping and forgets it on request", () => {
		assert.equal(lookupMapping(PI_SESSION), undefined, "nothing is mapped before the first turn");

		recordMapping(PI_SESSION, CC_SESSION, "/tmp/project");
		assert.equal(lookupMapping(PI_SESSION)?.sessionId, CC_SESSION);
		assert.equal(lookupMapping(PI_SESSION)?.cwd, "/tmp/project");

		dropMapping(PI_SESSION);
		assert.equal(lookupMapping(PI_SESSION), undefined, "a new/forked conversation must not inherit the mapping");
	});

	it("ignores a null pi session id rather than writing a junk key", () => {
		recordMapping(null, CC_SESSION, "/tmp/project");
		assert.equal(lookupMapping(null), undefined);
		assert.equal(lookupMapping(undefined), undefined);
	});

	// The regression itself: a resumed conversation must rebuild the Claude Code
	// session it already had, not create a second one.
	it("rebuilds the mapped session in place instead of orphaning it", () => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-cwd-"));
		const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-home-"));
		const prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = claudeDir;
		try {
			__test.setPiSessionId(PI_SESSION);

			// First run: no mapping yet, so a session is created and recorded.
			const first = __test.syncSharedSession(
				[
					{ role: "user", content: "first question", timestamp: Date.now() },
					{ role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: Date.now() },
					{ role: "user", content: "second question", timestamp: Date.now() },
				],
				cwd,
			);
			assert.ok(first.sessionId, "a first turn with priors must produce a session");
			assert.equal(
				lookupMapping(PI_SESSION)?.sessionId,
				first.sessionId,
				"the mapping must be persisted so a later process can find it",
			);

			// Simulate a restart: memory is gone, the mapping is re-adopted exactly
			// as the session_start handler does.
			const mapped = lookupMapping(PI_SESSION);
			__test.resetSharedSession();
			__test.setSharedSession({ sessionId: mapped.sessionId, cursor: 0, cwd: mapped.cwd, needsRebuild: true });

			const afterResume = __test.syncSharedSession(
				[
					{ role: "user", content: "first question", timestamp: Date.now() },
					{ role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: Date.now() },
					{ role: "user", content: "second question", timestamp: Date.now() },
					{ role: "assistant", content: [{ type: "text", text: "second answer" }], timestamp: Date.now() },
					{ role: "user", content: "third question", timestamp: Date.now() },
				],
				cwd,
			);

			assert.equal(
				afterResume.sessionId,
				first.sessionId,
				"resuming must reuse the Claude Code session id, not mint a new one",
			);

			// The decisive check: one session file, not two.
			const projectDirs = readdirSync(join(claudeDir, "projects"));
			const files = projectDirs.flatMap((d) =>
				readdirSync(join(claudeDir, "projects", d)).filter((f) => f.endsWith(".jsonl")),
			);
			assert.equal(
				files.length,
				1,
				`a resumed conversation must leave exactly one Claude Code session file, found ${files.length}: ${files.join(", ")}`,
			);
		} finally {
			if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
			rmSync(cwd, { recursive: true, force: true });
			rmSync(claudeDir, { recursive: true, force: true });
		}
	});
});
