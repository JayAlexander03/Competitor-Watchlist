import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  LastCheckResult,
  NotificationsState,
  Release,
  SentLogEntry,
  WatchItem,
} from "./types";

export interface WatchlistStore {
  listWatchItems(): Promise<WatchItem[]>;
  getWatchItem(id: string): Promise<WatchItem | null>;
  addWatchItem(
    company: string,
    project: string,
    pressUrl?: string | null,
  ): Promise<WatchItem>;
  removeWatchItem(id: string): Promise<boolean>;
  saveReleases(id: string, releases: Release[]): Promise<WatchItem | null>;
  touchChecked(id: string): Promise<WatchItem | null>;
  getNotifications(): Promise<NotificationsState>;
  setRecipients(recipients: string[]): Promise<NotificationsState>;
  appendSentLog(entry: SentLogEntry): Promise<NotificationsState>;
  setLastCheck(
    at: string,
    result: LastCheckResult,
  ): Promise<NotificationsState>;
}

const DATA_DIR = join(process.cwd(), "data");
const WATCHLIST_FILE = join(DATA_DIR, "watchlist.json");
const NOTIFICATIONS_FILE = join(DATA_DIR, "notifications.json");

const DEFAULT_NOTIFICATIONS: NotificationsState = {
  recipients: [],
  sentLog: [],
  lastCheckAt: null,
  lastResult: null,
};

// In-process promise mutex: serialize all read-modify-write cycles.
let mutex: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(fn, fn);
  // Keep the chain alive even if this op rejects.
  mutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return fallback;
    }
    throw err;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir();
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await rename(tmp, path);
}

async function readWatchItems(): Promise<WatchItem[]> {
  return readJsonFile<WatchItem[]>(WATCHLIST_FILE, []);
}

async function readNotifications(): Promise<NotificationsState> {
  const state = await readJsonFile<NotificationsState>(
    NOTIFICATIONS_FILE,
    DEFAULT_NOTIFICATIONS,
  );
  return {
    recipients: state.recipients ?? [],
    sentLog: state.sentLog ?? [],
    lastCheckAt: state.lastCheckAt ?? null,
    lastResult: state.lastResult ?? null,
  };
}

class FileWatchlistStore implements WatchlistStore {
  listWatchItems(): Promise<WatchItem[]> {
    return withLock(readWatchItems);
  }

  getWatchItem(id: string): Promise<WatchItem | null> {
    return withLock(async () => {
      const items = await readWatchItems();
      return items.find((i) => i.id === id) ?? null;
    });
  }

  addWatchItem(
    company: string,
    project: string,
    pressUrl?: string | null,
  ): Promise<WatchItem> {
    return withLock(async () => {
      const items = await readWatchItems();
      const now = new Date().toISOString();
      const item: WatchItem = {
        id: newId(),
        company,
        project,
        pressUrl: pressUrl ?? null,
        createdAt: now,
        lastCheckedAt: null,
        releases: [],
      };
      items.push(item);
      await writeJsonAtomic(WATCHLIST_FILE, items);
      return item;
    });
  }

  removeWatchItem(id: string): Promise<boolean> {
    return withLock(async () => {
      const items = await readWatchItems();
      const next = items.filter((i) => i.id !== id);
      if (next.length === items.length) return false;
      await writeJsonAtomic(WATCHLIST_FILE, next);
      return true;
    });
  }

  saveReleases(id: string, releases: Release[]): Promise<WatchItem | null> {
    return withLock(async () => {
      const items = await readWatchItems();
      const item = items.find((i) => i.id === id);
      if (!item) return null;
      item.releases = releases;
      await writeJsonAtomic(WATCHLIST_FILE, items);
      return item;
    });
  }

  touchChecked(id: string): Promise<WatchItem | null> {
    return withLock(async () => {
      const items = await readWatchItems();
      const item = items.find((i) => i.id === id);
      if (!item) return null;
      item.lastCheckedAt = new Date().toISOString();
      await writeJsonAtomic(WATCHLIST_FILE, items);
      return item;
    });
  }

  getNotifications(): Promise<NotificationsState> {
    return withLock(readNotifications);
  }

  setRecipients(recipients: string[]): Promise<NotificationsState> {
    return withLock(async () => {
      const state = await readNotifications();
      state.recipients = recipients;
      await writeJsonAtomic(NOTIFICATIONS_FILE, state);
      return state;
    });
  }

  appendSentLog(entry: SentLogEntry): Promise<NotificationsState> {
    return withLock(async () => {
      const state = await readNotifications();
      state.sentLog.push(entry);
      await writeJsonAtomic(NOTIFICATIONS_FILE, state);
      return state;
    });
  }

  setLastCheck(
    at: string,
    result: LastCheckResult,
  ): Promise<NotificationsState> {
    return withLock(async () => {
      const state = await readNotifications();
      state.lastCheckAt = at;
      state.lastResult = result;
      await writeJsonAtomic(NOTIFICATIONS_FILE, state);
      return state;
    });
  }
}

export const store: WatchlistStore = new FileWatchlistStore();
