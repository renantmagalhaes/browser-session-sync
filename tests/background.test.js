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
  buildSessionSummary,
  buildTimelineArchiveData,
  canonicalizeSessionPath,
  deleteExpiredSavedSessions,
  getProfileDisplayName,
  getLastTimelineSignature,
  handleManualDelete,
  normalizeArchiveIndex,
  normalizeIndex,
  normalizeProfileName,
  performSaveSessionToGitHub,
  putGitHubJson
} = require("../src/background/background.js");

test("two consecutive manual snapshots create two Saved files without a second Current write", async () => {
  const originalFetch = global.fetch;
  const originalSyncGet = chrome.storage.sync.get;
  const originalWindowsGetAll = chrome.windows.getAll;
  const files = new Map();
  let nextSha = 1;

  chrome.storage.sync.get = async (keys) => {
    const settings = {
      githubUsername: "owner",
      githubRepo: "repo",
      githubToken: "token",
      profileName: "Mainframe",
      profileKey: "rtm",
      excludeLocalTabs: false,
      timelineRetention: 10,
      savedRetention: 0,
      archiveRetention: 30
    };
    if (typeof keys === "string") return { [keys]: settings[keys] };
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, settings[key]]));
    }
    return { ...keys, ...settings };
  };
  chrome.windows.getAll = async () => [{
    id: 1,
    tabs: [{ title: "A", url: "https://a.example", active: true }]
  }];

  global.fetch = async (url, options = {}) => {
    const marker = "/contents/";
    const path = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length));
    if (!options.method) {
      const file = files.get(path);
      if (!file) {
        return { ok: false, status: 404, async json() { return { message: "Not Found" }; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            sha: file.sha,
            size: file.content.length,
            encoding: "base64",
            content: file.content
          };
        }
      };
    }

    if (options.method === "PUT") {
      const body = JSON.parse(options.body);
      const existing = files.get(path);
      if (existing && body.sha !== existing.sha) {
        return {
          ok: false,
          status: 409,
          async json() { return { message: `${existing.sha} is current but another SHA was expected` }; }
        };
      }
      const sha = `sha-${nextSha++}`;
      files.set(path, { sha, content: body.content });
      return {
        ok: true,
        status: 200,
        async json() { return { content: { sha } }; }
      };
    }

    throw new Error(`Unexpected ${options.method} ${url}`);
  };

  try {
    const first = await performSaveSessionToGitHub({
      forceSnapshot: true,
      friendlyName: "First"
    });
    const second = await performSaveSessionToGitHub({
      forceSnapshot: true,
      friendlyName: "Second"
    });
    assert.equal(first.success, true);
    assert.equal(second.success, true);

    const savedPaths = [...files.keys()].filter(
      (path) => path.startsWith("sessions/rtm/history/session-")
    );
    assert.equal(savedPaths.length, 2);
    assert.equal(files.has("sessions/rtm/latest.json"), true);

    const indexFile = files.get("sessions/index.json");
    const index = JSON.parse(Buffer.from(indexFile.content, "base64").toString("utf8"));
    assert.equal(index.sessions.filter((session) => session.kind === "history").length, 2);
    assert.equal(index.sessions.filter((session) => session.kind === "latest").length, 1);
  } finally {
    global.fetch = originalFetch;
    chrome.storage.sync.get = originalSyncGet;
    chrome.windows.getAll = originalWindowsGetAll;
  }
});

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
  assert.deepEqual(
    first.timelineSources.map((source) => source.browserAlias).sort(),
    ["Mainframe", "WorkPC"]
  );
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

  const summary = buildSessionSummary(
    first,
    "sessions/rtm/archive/timeline/day.json",
    "sha",
    "timelineArchive"
  );
  assert.equal(summary.browserAlias, "Mainframe, WorkPC");
  assert.match(summary.searchText, /mainframe/);
  assert.match(summary.searchText, /workpc/);
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

test("the app Profile Name for this installation overrides the legacy stored value", async () => {
  const originalLocalGet = chrome.storage.local.get;
  const originalSyncGet = chrome.storage.sync.get;
  chrome.storage.local.get = async () => ({ profileName: "WorkPC" });
  chrome.storage.sync.get = async () => ({ profileName: "Mainframe" });
  try {
    assert.equal(await getProfileDisplayName(), "WorkPC");
  } finally {
    chrome.storage.local.get = originalLocalGet;
    chrome.storage.sync.get = originalSyncGet;
  }
});

test("Profile Name comparisons normalize case and whitespace", () => {
  assert.equal(normalizeProfileName(" RTM  "), normalizeProfileName("rtm"));
  assert.notEqual(
    normalizeProfileName("Mainframe"),
    normalizeProfileName("WorkPC")
  );

  const summary = buildSessionSummary({
    timestamp: "2026-08-20T10:00:00Z",
    browserAlias: "RTM",
    profileKey: "rtm",
    clientId: null,
    windows: [],
    timelineSources: [
      { clientId: "one", browserAlias: "RTM" },
      { clientId: "two", browserAlias: "rtm" }
    ]
  }, "sessions/rtm/archive/timeline/day.json", "sha", "timelineArchive");
  assert.equal(summary.browserAlias, "RTM");
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
  assert.deepEqual(result.deleted, []);
});

test("Saved retention deletes only old unpinned snapshots when enabled", () => {
  const entries = [
    { path: "latest", kind: "latest", timestamp: "2000-01-01T00:00:00Z" },
    { path: "pinned", kind: "history", pinned: true, timestamp: "2000-01-01T00:00:00Z" },
    { path: "old-saved", kind: "history", timestamp: "2000-01-01T00:00:00Z" },
    { path: "recent-saved", kind: "history", timestamp: new Date().toISOString() }
  ];
  const result = applyRetention(entries, 10, 30);
  assert.deepEqual(
    result.kept.map((entry) => entry.path).sort(),
    ["latest", "pinned", "recent-saved"]
  );
  assert.deepEqual(result.deleted.map((entry) => entry.path), ["old-saved"]);
  assert.deepEqual(result.pruned, []);

  const disabled = applyRetention(entries, 10, 0);
  assert.deepEqual(disabled.deleted, []);
});

test("Saved count retention is shared by the Profile Folder", () => {
  const timestamp = new Date().toISOString();
  const entries = [
    ...Array.from({ length: 31 }, (_, index) => ({
      path: `sessions/rtm/history/mainframe-${index}.json`,
      kind: "history",
      profileKey: "rtm",
      clientId: "mainframe",
      timestamp: new Date(Date.now() - index * 1000).toISOString()
    })),
    {
      path: "sessions/rtm/history/workpc.json",
      kind: "history",
      profileKey: "rtm",
      clientId: "workpc",
      timestamp
    }
  ];
  const result = applyRetention(entries, 10, 0);
  assert.equal(result.kept.length, 30);
  assert.equal(result.pruned.length, 2);
});

test("manual delete rejects the shared Current file", async () => {
  const result = await handleManualDelete({
    path: "sessions/rtm/latest.json",
    profileKey: "rtm",
    kind: "latest"
  });
  assert.equal(result.success, false);
  assert.match(result.error, /Current sessions cannot be deleted/);
});

test("deleting one computer's Saved snapshot preserves the other computer in the shared folder", async () => {
  const originalFetch = global.fetch;
  const targetPath = "sessions/rtm/history/mainframe.json";
  const otherPath = "sessions/rtm/history/workpc.json";
  const files = new Map([
    [targetPath, {
      sha: "target-sha",
      data: { timestamp: "2026-08-20T10:00:00Z", windows: [] }
    }],
    ["sessions/index.json", {
      sha: "index-sha",
      data: {
        version: 2,
        sessions: [
          {
            path: targetPath,
            kind: "history",
            profileKey: "rtm",
            clientId: "mainframe",
            browserAlias: "Mainframe",
            timestamp: "2026-08-20T10:00:00Z"
          },
          {
            path: otherPath,
            kind: "history",
            profileKey: "rtm",
            clientId: "workpc",
            browserAlias: "WorkPC",
            timestamp: "2026-08-20T11:00:00Z"
          }
        ]
      }
    }]
  ]);

  global.fetch = async (url, options = {}) => {
    const marker = "/contents/";
    const path = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length));
    if (!options.method) {
      const file = files.get(path);
      if (!file) {
        return { ok: false, status: 404, async json() { return {}; } };
      }
      const content = Buffer.from(JSON.stringify(file.data)).toString("base64");
      return {
        ok: true,
        status: 200,
        async json() {
          return { sha: file.sha, size: content.length, encoding: "base64", content };
        }
      };
    }
    if (options.method === "DELETE") {
      files.delete(path);
      return { ok: true, status: 200, async json() { return {}; } };
    }
    if (options.method === "PUT") {
      const body = JSON.parse(options.body);
      const data = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
      files.set(path, { sha: "updated-index-sha", data });
      return {
        ok: true,
        status: 200,
        async json() { return { content: { sha: "updated-index-sha" } }; }
      };
    }
    throw new Error(`Unexpected ${options.method} ${url}`);
  };

  try {
    const result = await handleManualDelete({
      path: targetPath,
      kind: "history",
      profileKey: "rtm",
      clientId: "mainframe",
      browserAlias: "Mainframe"
    });
    assert.equal(result.success, true);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(files.has(targetPath), false);
  assert.deepEqual(
    files.get("sessions/index.json").data.sessions.map((session) => session.path),
    [otherPath]
  );
});

test("expired Saved retention removes the physical GitHub file", async () => {
  const originalFetch = global.fetch;
  let deleteBody;
  global.fetch = async (_url, options = {}) => {
    if (options.method === "DELETE") {
      deleteBody = JSON.parse(options.body);
      return { ok: true, status: 200, async json() { return {}; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          sha: "saved-sha",
          size: 2,
          encoding: "base64",
          content: Buffer.from("{}").toString("base64")
        };
      }
    };
  };

  try {
    await deleteExpiredSavedSessions([{
      path: "sessions/rtm/history/session-old.json"
    }]);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(deleteBody.sha, "saved-sha");
  assert.match(deleteBody.message, /Delete expired Saved snapshot/);
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
