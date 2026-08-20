const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");

global.crypto = webcrypto;
global.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
    openOptionsPage() {}
  },
  alarms: {
    onAlarm: { addListener() {} },
    async get() { return null; },
    async create() {},
    async clear() {}
  },
  storage: {
    local: {
      async get() { return { clientId: "test-client" }; },
      async set() {}
    },
    sync: {
      async get(keys) {
        if (typeof keys === "string") {
          return keys === "githubToken" ? { githubToken: "token" } : {};
        }
        if (Array.isArray(keys)) {
          return {
            githubUsername: "owner",
            githubRepo: "repo"
          };
        }
        return { ...keys };
      },
      async set() {}
    }
  },
  windows: { async getAll() { return []; } }
};

const {
  applyRetention,
  buildTimelineArchiveData,
  canonicalizeSessionPath,
  getLastTimelineSignature,
  normalizeArchiveIndex,
  normalizeIndex,
  putGitHubJson
} = require("../src/background/background.js");

test("daily Timeline archive deduplicates URLs and is retry-idempotent", async () => {
  const sourceFiles = [
    {
      summary: { path: "sessions/rtm/history/timeline/one.json" },
      data: {
        timestamp: "2026-08-01T09:00:00Z",
        browserAlias: "Mainframe",
        windows: [{ tabs: [{ title: "Old title", url: "https://a.example" }] }]
      }
    },
    {
      summary: { path: "sessions/rtm/history/timeline/two.json" },
      data: {
        timestamp: "2026-08-01T17:00:00Z",
        browserAlias: "WorkPC",
        windows: [{ tabs: [
          { title: "New title", url: "https://a.example" },
          { title: "B", url: "https://b.example" }
        ] }]
      }
    }
  ];
  const first = await buildTimelineArchiveData(
    null,
    sourceFiles,
    sourceFiles[1].data,
    "2026-08-01"
  );
  assert.equal(first.windows[0].tabs.length, 2);
  assert.equal(first.timelineSnapshotCount, 2);
  const tabA = first.windows[0].tabs.find((tab) => tab.url === "https://a.example");
  assert.equal(tabA.firstSeenAt, "2026-08-01T09:00:00Z");
  assert.equal(tabA.lastSeenAt, "2026-08-01T17:00:00Z");

  const retried = await buildTimelineArchiveData(
    first,
    sourceFiles,
    sourceFiles[1].data,
    "2026-08-01"
  );
  assert.equal(retried.windows[0].tabs.length, 2);
  assert.equal(retried.timelineSnapshotCount, 2);
});

test("timeline deduplication compares each computer with its own last entry", () => {
  const index = {
    sessions: [
      {
        kind: "timeline",
        profileKey: "rtm",
        clientId: "mainframe",
        timestamp: "2026-08-20T10:00:00Z",
        signature: "mainframe-state"
      },
      {
        kind: "timeline",
        profileKey: "rtm",
        clientId: "workpc",
        timestamp: "2026-08-20T11:00:00Z",
        signature: "workpc-state"
      }
    ]
  };
  assert.equal(
    getLastTimelineSignature(index, "rtm", "mainframe"),
    "mainframe-state"
  );
});

test("normalizes and deduplicates active index entries by path", () => {
  const index = normalizeIndex({
    sessions: [
      { path: "sessions/rtm/latest.json", timestamp: "2026-01-01T00:00:00Z" },
      { path: "sessions/rtm/latest.json", timestamp: "2026-01-02T00:00:00Z" },
      { path: "work/latest.json", profileKey: "work", timestamp: "2026-01-02T00:00:00Z" },
      { path: "", timestamp: "2026-01-03T00:00:00Z" }
    ]
  });
  assert.equal(index.sessions.length, 2);
  assert.equal(index.sessions[0].timestamp, "2026-01-02T00:00:00Z");
  assert.deepEqual(index.sessions[0].previewTabs, []);
  assert.equal(index.sessions[1].path, "sessions/work/latest.json");
});

test("canonicalizes legacy archive paths under sessions", () => {
  assert.equal(
    canonicalizeSessionPath("rtm/archive/2026/07/session-1.json", "rtm"),
    "sessions/rtm/archive/2026/07/session-1.json"
  );
  assert.equal(
    canonicalizeSessionPath("sessions/rtm/archive/day.json", "rtm"),
    "sessions/rtm/archive/day.json"
  );
  const normalized = normalizeArchiveIndex("rtm", {
    sessions: [{
      path: "rtm/archive/2026/07/session-1.json",
      timestamp: "2026-07-01T00:00:00Z"
    }]
  });
  assert.equal(normalized.sessions[0].path, "sessions/rtm/archive/2026/07/session-1.json");
});

test("retention keeps current and pinned items while pruning old timeline", () => {
  const entries = [
    { path: "latest", kind: "latest", timestamp: "2000-01-01T00:00:00Z" },
    { path: "pinned", kind: "timeline", pinned: true, timestamp: "2000-01-01T00:00:00Z" },
    { path: "old-timeline", kind: "timeline", timestamp: "2000-01-01T00:00:00Z" }
  ];
  const result = applyRetention(entries, 10);
  assert.deepEqual(result.kept.map((entry) => entry.path).sort(), ["latest", "pinned"]);
  assert.deepEqual(result.pruned.map((entry) => entry.path), ["old-timeline"]);
});

test("conflict retry recomputes JSON from the newest remote value", async () => {
  const originalFetch = global.fetch;
  let getCount = 0;
  let putCount = 0;
  let committed;
  const remoteVersions = [
    { sha: "sha-1", data: { values: ["first"] } },
    { sha: "sha-2", data: { values: ["first", "concurrent"] } }
  ];

  global.fetch = async (_url, options = {}) => {
    if (options.method === "PUT") {
      putCount++;
      const body = JSON.parse(options.body);
      if (putCount === 1) {
        return { ok: false, status: 409, async json() { return { message: "SHA conflict" }; } };
      }
      committed = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
      return { ok: true, status: 200, async json() { return { content: { sha: "sha-3" } }; } };
    }

    const version = remoteVersions[Math.min(getCount++, remoteVersions.length - 1)];
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          sha: version.sha,
          size: 100,
          encoding: "base64",
          content: Buffer.from(JSON.stringify(version.data)).toString("base64")
        };
      }
    };
  };

  try {
    await putGitHubJson("sessions/index.json", null, "test", undefined, {
      conflictResolver: (current) => ({
        values: [...current.values, "ours"]
      })
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(putCount, 2);
  assert.deepEqual(committed.values, ["first", "concurrent", "ours"]);
});
