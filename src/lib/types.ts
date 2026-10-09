export type ReleaseSource = "company" | "sedar" | "news";

export interface Release {
  /** Normalized URL id, else sha256(title|url|date). */
  id: string;
  source: ReleaseSource;
  title: string;
  url: string;
  /** Display date, DD-MMM-YYYY (e.g. 09-Oct-2026). */
  date: string;
  /** sha256(title|url|date). */
  hash: string;
  /** ISO timestamp when first seen. */
  firstSeenAt: string;
}

export interface WatchItem {
  id: string;
  company: string;
  project: string;
  pressUrl?: string | null;
  createdAt: string;
  lastCheckedAt: string | null;
  releases: Release[];
}

export interface SentLogEntry {
  releaseId: string;
  to: string[];
  sentAt: string;
}

export interface LastCheckResult {
  checked: number;
  newCount: number;
}

export interface NotificationsState {
  recipients: string[];
  sentLog: SentLogEntry[];
  lastCheckAt: string | null;
  lastResult: LastCheckResult | null;
}

export interface SearchRequest {
  company: string;
  project: string;
  pressUrl?: string;
}
