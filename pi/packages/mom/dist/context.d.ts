/**
 * Context management for mom.
 *
 * Mom uses two files per channel:
 * - context.jsonl: Structured API messages for LLM context (same format as coding-agent sessions)
 * - log.jsonl: Human-readable channel history for grep (no tool results)
 *
 * This module provides:
 * - syncLogToSessionManager: Syncs messages from log.jsonl to SessionManager
 * - MomSettingsManager: Simple settings for mom (compaction, retry, model preferences)
 */
import type { SessionManager } from "@mariozechner/pi-coding-agent";
/**
 * Sync user messages from log.jsonl to SessionManager.
 *
 * This ensures that messages logged while mom wasn't running (channel chatter,
 * backfilled messages, messages while busy) are added to the LLM context.
 *
 * @param sessionManager - The SessionManager to sync to
 * @param channelDir - Path to channel directory containing log.jsonl
 * @param excludeSlackTs - Slack timestamp of current message (will be added via prompt(), not sync)
 * @returns Number of messages synced
 */
export declare function syncLogToSessionManager(sessionManager: SessionManager, channelDir: string, excludeSlackTs?: string): number;
export interface MomCompactionSettings {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
}
export interface MomRetrySettings {
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
}
export interface MomSettings {
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
    compaction?: Partial<MomCompactionSettings>;
    retry?: Partial<MomRetrySettings>;
}
/**
 * Settings manager for mom.
 * Stores settings in the workspace root directory.
 */
export declare class MomSettingsManager {
    private settingsPath;
    private settings;
    constructor(workspaceDir: string);
    private load;
    private save;
    getCompactionSettings(): MomCompactionSettings;
    getCompactionEnabled(): boolean;
    setCompactionEnabled(enabled: boolean): void;
    getRetrySettings(): MomRetrySettings;
    getRetryEnabled(): boolean;
    setRetryEnabled(enabled: boolean): void;
    getDefaultModel(): string | undefined;
    getDefaultProvider(): string | undefined;
    setDefaultModelAndProvider(provider: string, modelId: string): void;
    getDefaultThinkingLevel(): string;
    setDefaultThinkingLevel(level: string): void;
    getSteeringMode(): "all" | "one-at-a-time";
    setSteeringMode(_mode: "all" | "one-at-a-time"): void;
    getFollowUpMode(): "all" | "one-at-a-time";
    setFollowUpMode(_mode: "all" | "one-at-a-time"): void;
    getHookPaths(): string[];
    getHookTimeout(): number;
}
//# sourceMappingURL=context.d.ts.map