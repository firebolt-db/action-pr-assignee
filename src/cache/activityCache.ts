import * as cache from '@actions/cache';
import * as core from '@actions/core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SignalsByLogin } from '../adapters/github/signals.js';

export interface ActivityCachePayload {
  fetchedAt: string;
  activityWindowDays: number;
  signalsByLogin: SignalsByLogin;
}

interface CacheProvider {
  restoreCache(paths: string[], primaryKey: string, restoreKeys?: string[]): Promise<string | undefined>;
  saveCache(paths: string[], key: string): Promise<number>;
}

const defaultCacheProvider: CacheProvider = {
  restoreCache: cache.restoreCache,
  saveCache: cache.saveCache,
};

function makeCacheKeyPrefix(owner: string, repo: string): string {
  return `pr-assignee-activity-${owner}-${repo}-`;
}

function makeSaveKey(owner: string, repo: string): string {
  const runId = process.env.GITHUB_RUN_ID ?? Date.now().toString();
  return `${makeCacheKeyPrefix(owner, repo)}${runId}`;
}

function makeCacheFilePath(owner: string, repo: string): string {
  const safeRepo = `${owner}-${repo}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return join(tmpdir(), 'pr-assignee-cache', safeRepo, 'activity.json');
}

function isStale(fetchedAt: string): boolean {
  const fetched = new Date(fetchedAt).getTime();
  const now = Date.now();
  if (Number.isNaN(fetched)) return true;
  return now - fetched > 60 * 60 * 1000;
}

export async function restoreActivityCache(
  owner: string,
  repo: string,
  expectedActivityWindowDays: number,
  cacheProvider: CacheProvider = defaultCacheProvider,
): Promise<ActivityCachePayload | null> {
  const cacheFilePath = makeCacheFilePath(owner, repo);
  const primaryKey = makeSaveKey(owner, repo);
  const restorePrefix = makeCacheKeyPrefix(owner, repo);

  try {
    const matchedKey = await cacheProvider.restoreCache([cacheFilePath], primaryKey, [restorePrefix]);
    if (!matchedKey) {
      core.debug('Activity cache not found; falling back to live fetch.');
      return null;
    }

    const raw = await readFile(cacheFilePath, 'utf8');
    const payload = JSON.parse(raw) as ActivityCachePayload;

    if (payload.activityWindowDays !== expectedActivityWindowDays) {
      core.debug('Discarding activity cache due to activity_window_days mismatch.');
      return null;
    }

    if (isStale(payload.fetchedAt)) {
      core.debug('Discarding activity cache older than 1 hour.');
      return null;
    }

    core.debug(`Restored activity cache from key: ${matchedKey}`);
    return payload;
  } catch (error) {
    core.debug(`Activity cache restore failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function saveActivityCache(
  owner: string,
  repo: string,
  payload: ActivityCachePayload,
  cacheProvider: CacheProvider = defaultCacheProvider,
): Promise<void> {
  const cacheFilePath = makeCacheFilePath(owner, repo);
  const cacheDir = dirname(cacheFilePath);

  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFilePath, JSON.stringify(payload), 'utf8');
    const saveKey = makeSaveKey(owner, repo);
    await cacheProvider.saveCache([cacheFilePath], saveKey);
    core.debug(`Saved activity cache key: ${saveKey}`);
  } catch (error) {
    core.debug(`Activity cache save failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
