// Maps a pi session to the Claude Code session that backs it, across process
// restarts.
//
// Why this exists: sharedSession lives in module memory and is cleared on
// session_start. Resuming a pi conversation therefore lost the mapping, and the
// REBUILD path minted a FRESH Claude Code session id containing the whole
// history — leaving the previous file orphaned in ~/.claude/projects. One
// orphan per resume, each a growing copy of the same conversation.
//
// Persisting the mapping lets a resume rebuild in place, reusing the existing
// session id, so a pi conversation keeps exactly one Claude Code session for
// its lifetime.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface MappedSession {
	/** Claude Code session id backing this pi session. */
	sessionId: string;
	/** cwd the Claude Code session was created under; its project dir depends on this. */
	cwd: string;
	/** ISO timestamp, used to prune entries that are no longer worth keeping. */
	updatedAt: string;
}

type MapFile = Record<string, MappedSession>;

/** Entries older than this are dropped on write; a pi session unused for this long is not coming back. */
const MAX_AGE_DAYS = 60;

export function mapPath(): string {
	return join(getAgentDir(), "claude-bridge-sessions.json");
}

function load(): MapFile {
	const path = mapPath();
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as MapFile;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		// A corrupt map must not stop the bridge starting; a lost mapping only
		// costs one extra rebuild.
		return {};
	}
}

function prune(map: MapFile): MapFile {
	const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
	const out: MapFile = {};
	for (const [key, value] of Object.entries(map)) {
		const at = Date.parse(value?.updatedAt ?? "");
		if (Number.isNaN(at) || at >= cutoff) out[key] = value;
	}
	return out;
}

function save(map: MapFile): void {
	const path = mapPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		// Write-and-rename so a crash mid-write cannot leave an unparseable map.
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(prune(map), null, 2)}\n`);
		renameSync(tmp, path);
	} catch (error) {
		// Persistence is an optimisation, never a hard dependency.
		console.error(`claude-bridge: could not write session map: ${(error as Error).message}`);
	}
}

export function lookupMapping(piSessionId: string | null | undefined): MappedSession | undefined {
	if (!piSessionId) return undefined;
	return load()[piSessionId];
}

export function recordMapping(piSessionId: string | null | undefined, sessionId: string, cwd: string): void {
	if (!piSessionId) return;
	const map = load();
	const existing = map[piSessionId];
	if (existing?.sessionId === sessionId && existing.cwd === cwd) return; // nothing changed
	map[piSessionId] = { sessionId, cwd, updatedAt: new Date().toISOString() };
	save(map);
}

export function dropMapping(piSessionId: string | null | undefined): void {
	if (!piSessionId) return;
	const map = load();
	if (!(piSessionId in map)) return;
	delete map[piSessionId];
	save(map);
}

/** Exposed for tests: remove the map entirely. */
export function clearMappings(): void {
	const path = mapPath();
	if (existsSync(path)) unlinkSync(path);
}
