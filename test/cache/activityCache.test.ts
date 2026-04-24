import { describe, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { restoreActivityCache, saveActivityCache, type ActivityCachePayload } from '../../src/cache/activityCache.js';

describe('activity cache', () => {
  it('returns null on cache miss', async () => {
    const payload = await restoreActivityCache('owner', 'repo', 30, {
      restoreCache: async () => undefined,
      saveCache: async () => 0,
    });

    expect(payload).toBeNull();
  });

  it('returns null when cache payload is stale', async () => {
    const stalePayload: ActivityCachePayload = {
      fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      activityWindowDays: 30,
      signalsByLogin: {},
    };

    const payload = await restoreActivityCache('owner', 'repo', 30, {
      restoreCache: async (paths) => {
        await mkdir(dirname(paths[0]!), { recursive: true });
        await writeFile(paths[0]!, JSON.stringify(stalePayload), 'utf8');
        return 'cache-key';
      },
      saveCache: async () => 0,
    });

    expect(payload).toBeNull();
  });

  it('returns null when window config mismatches', async () => {
    const mismatchedPayload: ActivityCachePayload = {
      fetchedAt: new Date().toISOString(),
      activityWindowDays: 10,
      signalsByLogin: {},
    };

    const payload = await restoreActivityCache('owner', 'repo', 30, {
      restoreCache: async (paths) => {
        await mkdir(dirname(paths[0]!), { recursive: true });
        await writeFile(paths[0]!, JSON.stringify(mismatchedPayload), 'utf8');
        return 'cache-key';
      },
      saveCache: async () => 0,
    });

    expect(payload).toBeNull();
  });

  it('restores valid cache payload', async () => {
    const freshPayload: ActivityCachePayload = {
      fetchedAt: new Date().toISOString(),
      activityWindowDays: 30,
      signalsByLogin: {
        alice: {
          activity: { openAssignedPrs: 1, pendingReviewRequests: 0, recentAssignments: 0 },
          review: { distinctOverlappingReviewedPrs: 1 },
          commitsOnTouchedPaths: 2,
        },
      },
    };

    const payload = await restoreActivityCache('owner', 'repo', 30, {
      restoreCache: async (paths) => {
        await mkdir(dirname(paths[0]!), { recursive: true });
        await writeFile(paths[0]!, JSON.stringify(freshPayload), 'utf8');
        return 'cache-key';
      },
      saveCache: async () => 0,
    });

    expect(payload).toEqual(freshPayload);
  });

  it('writes and saves cache payload', async () => {
    let savedPaths: string[] = [];
    let savedKey = '';

    await saveActivityCache(
      'owner',
      'repo',
      {
        fetchedAt: new Date().toISOString(),
        activityWindowDays: 30,
        signalsByLogin: {},
      },
      {
        restoreCache: async () => undefined,
        saveCache: async (paths, key) => {
          savedPaths = paths;
          savedKey = key;
          return 1;
        },
      },
    );

    expect(savedPaths.length).toBe(1);
    expect(savedKey.startsWith('pr-assignee-activity-owner-repo-')).toBe(true);
  });
});
