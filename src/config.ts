// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-bridge.json)
// and the project Pi config directory, project overriding global. Missing or
// unparseable files are ignored (error to console.error, empty object
// returned) so the extension always starts.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface Config {
	/** Date (YYYY-MM-DD) the one-time startup notice was shown. Written by the extension, not the user. */
	startupNoticeShown?: string;
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		/**
		 * Which system prompt Claude Code receives.
		 * "preset" (default) - the built-in claude_code preset (~8k tokens).
		 * "replace"          - use the user's own prompt (--system-prompt / SYSTEM.md)
		 *                      in place of the preset, matching pi's SYSTEM.md
		 *                      semantics. Falls back to the preset if none is set.
		 * any other string   - that string, used as the prompt.
		 * AGENTS.md and the skills block are appended in every mode.
		 */
		systemPrompt?: "preset" | "replace" | string;
		/**
		 * Path to a file holding the prompt, taking precedence over systemPrompt.
		 * Supports a leading "~/".
		 *
		 * Prefer this over pi's SYSTEM.md when other providers are configured:
		 * SYSTEM.md replaces pi's prompt for EVERY provider, dropping pi's tool
		 * list, guidelines and documentation block for all of them. A file named
		 * here applies to this bridge alone. Unreadable or empty falls through to
		 * systemPrompt, so a bad path degrades instead of sending nothing.
		 */
		systemPromptFile?: string;
		appendSystemPrompt?: boolean;
		settingSources?: SettingSource[];
		strictMcpConfig?: boolean;
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context
		plan?: "pro" | "max";
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
	};
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

/** Record today's date in the global config so the startup notice shows once. Preserves every other field. */
export function markStartupNoticeShown(): string {
	const path = globalConfigPath();
	// en-CA renders YYYY-MM-DD in local time; toISOString() would report UTC.
	const today = new Date().toLocaleDateString("en-CA");
	const next = { ...tryParseJson(path), startupNoticeShown: today };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return path;
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(globalConfigPath());
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	return {
		startupNoticeShown: project.startupNoticeShown ?? global.startupNoticeShown,
		askClaude: { ...global.askClaude, ...project.askClaude },
		provider: { ...global.provider, ...project.provider },
	};
}
