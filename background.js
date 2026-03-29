/**
 * Background Service Worker for Browser Session Sync
 * Handles:
 * - Client ID initialization
 * - GitHub API calls
 * - Periodic syncing with alarms
 * - Session saving and restoring
 */

const SESSIONS_DIR = "sessions";
const INDEX_PATH = `${SESSIONS_DIR}/index.json`;
const MAX_HISTORY_PER_CLIENT = 20;

console.log(
  "Service Worker: Initializing..."
);

async function handleMessage(request) {
  switch (request.action) {
    case "saveSession":
      console.log(
        "Processing saveSession"
      );
      return await saveSessionToGitHub({
        forceSnapshot: false
      });

    case "saveSnapshot":
      console.log(
        "Processing saveSnapshot"
      );
      return await saveSessionToGitHub({
        forceSnapshot: true
      });

    case "listSessions":
      console.log(
        "Processing listSessions"
      );
      return await listAllSessions();

    case "restoreSession":
      console.log(
        "Processing restoreSession"
      );
      return await restoreSession(
        request.sessionPath
      );

    case "getSessionDetails":
      console.log(
        "Processing getSessionDetails"
      );
      return await getSessionDetails(
        request.sessionPath
      );

    case "getStatus": {
      console.log(
        "Processing getStatus"
      );
      const syncData =
        await chrome.storage.sync.get([
          "lastSyncTime",
          "lastSyncStatus"
        ]);
      const localData =
        await chrome.storage.local.get([
          "clientId"
        ]);
      const id =
        localData.clientId ||
        (await initializeClientId());
      return {
        lastSyncTime:
          syncData.lastSyncTime,
        lastSyncStatus:
          syncData.lastSyncStatus,
        clientId: id
      };
    }

    case "setupSync":
      console.log(
        "Processing setupSync"
      );
      await setupSyncAlarm(
        request.intervalMinutes
      );
      return { success: true };

    default:
      console.warn(
        "Unknown action:",
        request.action
      );
      return {
        success: false,
        error: "Unknown action"
      };
  }
}

// Register message listener IMMEDIATELY.
// Keep the listener itself synchronous so sendResponse stays valid.
chrome.runtime.onMessage.addListener(
  (request, sender, sendResponse) => {
    console.log(
      "Message received:",
      request.action
    );

    handleMessage(request)
      .then((response) => {
        console.log(
          "Sending response:",
          response
        );
        sendResponse(response);
      })
      .catch((error) => {
        console.error(
          "Error handling message:",
          error
        );
        sendResponse({
          success: false,
          error: error.message
        });
      });

    return true;
  }
);

console.log(
  "Service Worker: Message listener registered"
);

/**
 * Initialize client ID if it doesn't exist
 */
async function initializeClientId() {
  const { clientId } =
    await chrome.storage.local.get(
      "clientId"
    );
  if (!clientId) {
    const newClientId =
      crypto.randomUUID();
    await chrome.storage.local.set({
      clientId: newClientId
    });
    console.log(
      "Initialized new client ID:",
      newClientId
    );
    return newClientId;
  }
  return clientId;
}

/**
 * Get GitHub API headers with authentication
 */
async function getGitHubHeaders() {
  const { githubToken } =
    await chrome.storage.sync.get(
      "githubToken"
    );
  if (!githubToken) {
    throw new Error(
      "GitHub token not configured"
    );
  }
  return {
    Authorization: `token ${githubToken}`,
    Accept:
      "application/vnd.github.v3+json",
    "Content-Type": "application/json"
  };
}

/**
 * Get the repository URL in the correct format
 */
async function getRepoUrl() {
  const { githubUsername, githubRepo } =
    await chrome.storage.sync.get([
      "githubUsername",
      "githubRepo"
    ]);

  if (!githubUsername || !githubRepo) {
    throw new Error(
      "GitHub credentials not configured"
    );
  }

  return `https://api.github.com/repos/${githubUsername}/${githubRepo}`;
}

function slugifyProfileKey(value) {
  return (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function getProfileStorageKey() {
  const clientId =
    await initializeClientId();
  const { profileKey, profileName } =
    await chrome.storage.sync.get([
      "profileKey",
      "profileName"
    ]);
  const normalizedKey =
    slugifyProfileKey(profileKey) ||
    slugifyProfileKey(profileName) ||
    clientId;

  if (normalizedKey !== profileKey) {
    await chrome.storage.sync.set({
      profileKey: normalizedKey
    });
  }

  return normalizedKey;
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(
    text
  );
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function decodeBase64Utf8(base64) {
  const binary = atob(
    base64.replace(/\n/g, "")
  );
  const bytes = Uint8Array.from(
    binary,
    (char) => char.charCodeAt(0)
  );
  return new TextDecoder().decode(bytes);
}

async function parseGitHubError(response) {
  try {
    const error = await response.json();
    return (
      error.message ||
      `GitHub API error (${response.status})`
    );
  } catch {
    return `GitHub API error (${response.status})`;
  }
}

async function fetchGitHubJson(path) {
  const repoUrl = await getRepoUrl();
  const headers =
    await getGitHubHeaders();
  const response = await fetch(
    `${repoUrl}/contents/${path}`,
    { headers }
  );

  if (response.status === 404) {
    return { exists: false };
  }

  if (!response.ok) {
    throw new Error(
      await parseGitHubError(response)
    );
  }

  const payload = await response.json();

  if (Array.isArray(payload)) {
    throw new Error(
      `Expected file at ${path}, got directory`
    );
  }

  return {
    exists: true,
    sha: payload.sha,
    data: JSON.parse(
      decodeBase64Utf8(payload.content || "")
    )
  };
}

async function listGitHubDirectory(path) {
  const repoUrl = await getRepoUrl();
  const headers =
    await getGitHubHeaders();
  const response = await fetch(
    `${repoUrl}/contents/${path}`,
    { headers }
  );

  if (response.status === 404) {
    return { exists: false, entries: [] };
  }

  if (!response.ok) {
    throw new Error(
      await parseGitHubError(response)
    );
  }

  const payload = await response.json();
  return {
    exists: true,
    entries: Array.isArray(payload)
      ? payload
      : []
  };
}

async function putGitHubJson(
  path,
  data,
  message,
  sha
) {
  const repoUrl = await getRepoUrl();
  const headers =
    await getGitHubHeaders();
  let currentSha = sha;

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(
      `${repoUrl}/contents/${path}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          message,
          content: encodeBase64Utf8(
            JSON.stringify(data, null, 2)
          ),
          ...(currentSha
            ? { sha: currentSha }
            : {})
        })
      }
    );

    if (response.ok) {
      return await response.json();
    }

    const errorMessage =
      await parseGitHubError(response);
    const shouldRetryWithFreshSha =
      attempt === 0 &&
      response.status === 422 &&
      errorMessage.includes("sha");

    if (!shouldRetryWithFreshSha) {
      throw new Error(errorMessage);
    }

    const existingFile =
      await fetchGitHubJson(path);
    currentSha = existingFile.exists
      ? existingFile.sha
      : undefined;
  }

  throw new Error(
    `Failed to write ${path}`
  );
}

async function deleteGitHubFile(
  path,
  sha,
  message
) {
  if (!sha) {
    return;
  }

  const repoUrl = await getRepoUrl();
  const headers =
    await getGitHubHeaders();
  const response = await fetch(
    `${repoUrl}/contents/${path}`,
    {
      method: "DELETE",
      headers,
      body: JSON.stringify({
        message,
        sha
      })
    }
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(
      await parseGitHubError(response)
    );
  }
}

function normalizeIndex(indexData) {
  const sessions = Array.isArray(
    indexData?.sessions
  )
    ? indexData.sessions
    : [];

  return {
    version: 2,
    updatedAt:
      indexData?.updatedAt || null,
    sessions: sessions
      .filter(
        (session) =>
          session &&
          session.path &&
          session.timestamp
      )
      .map((session) => ({
        ...session,
        previewTabs: Array.isArray(
          session.previewTabs
        )
          ? session.previewTabs
          : [],
        searchText:
          session.searchText || ""
      }))
  };
}

function buildSearchText(
  sessionData,
  tabs
) {
  return [
    sessionData.browserAlias,
    sessionData.profileKey,
    sessionData.clientId,
    ...tabs.flatMap((tab) => [
      tab.title || "",
      tab.url || ""
    ])
  ]
    .join(" ")
    .toLowerCase();
}

function buildSessionSummary(
  sessionData,
  path,
  sha,
  kind = "history"
) {
  const tabs = sessionData.windows.flatMap(
    (windowData) => windowData.tabs
  );

  return {
    path,
    sha,
    kind,
    timestamp: sessionData.timestamp,
    browserAlias:
      sessionData.browserAlias,
    profileKey:
      sessionData.profileKey || "",
    clientId: sessionData.clientId,
    windowCount:
      sessionData.windows.length,
    tabCount: tabs.length,
    previewTabs: tabs
      .slice(0, 3)
      .map((tab) => ({
        title: tab.title || "Untitled",
        url: tab.url || ""
      })),
    searchText: buildSearchText(
      sessionData,
      tabs
    )
  };
}

function applyRetention(
  sessionEntries
) {
  const pinned = sessionEntries.filter(
    (session) => session.kind === "latest"
  );
  const historyEntries =
    sessionEntries.filter(
      (session) => session.kind !== "latest"
    );
  const keptHistory = [];
  const pruned = [];
  const countByClient = new Map();

  const sorted = [...historyEntries].sort(
    (a, b) =>
      new Date(b.timestamp) -
      new Date(a.timestamp)
  );

  for (const session of sorted) {
    const key =
      session.profileKey ||
      session.clientId ||
      "unknown";
    const count =
      countByClient.get(key) || 0;

    if (count < MAX_HISTORY_PER_CLIENT) {
      keptHistory.push(session);
      countByClient.set(key, count + 1);
    } else {
      pruned.push(session);
    }
  }

  return {
    kept: [...pinned, ...keptHistory],
    pruned
  };
}

function isLegacySessionFile(entry) {
  return (
    entry.type === "file" &&
    entry.name.startsWith("session-") &&
    entry.name.endsWith(".json")
  );
}

async function readSessionSummary(path, sha) {
  const file = await fetchGitHubJson(path);

  if (!file.exists) {
    return null;
  }

  return buildSessionSummary(
    file.data,
    path,
    sha || file.sha
  );
}

async function buildIndexFromRepository() {
  const rootDir =
    await listGitHubDirectory(
      SESSIONS_DIR
    );

  if (!rootDir.exists) {
    return normalizeIndex({
      sessions: []
    });
  }

  const summaries = [];

  for (const entry of rootDir.entries) {
    if (entry.type !== "dir") {
      continue;
    }

    const clientRootPath = `${SESSIONS_DIR}/${entry.name}`;
    const clientRoot =
      await listGitHubDirectory(
        clientRootPath
      );

    for (const clientEntry of clientRoot.entries) {
      if (
        clientEntry.type === "dir" &&
        clientEntry.name === "history"
      ) {
        const historyDir =
          await listGitHubDirectory(
            `${clientRootPath}/history`
          );

        for (const historyFile of historyDir.entries) {
          if (
            isLegacySessionFile(
              historyFile
            )
          ) {
            const summary =
              await readSessionSummary(
                historyFile.path,
                historyFile.sha
              );

            if (summary) {
              summary.kind = "history";
              summaries.push(summary);
            }
          }
        }
      } else if (
        clientEntry.type === "file" &&
        clientEntry.name === "latest.json"
      ) {
        const summary =
          await readSessionSummary(
            clientEntry.path,
            clientEntry.sha
          );

        if (summary) {
          summary.kind = "latest";
          summaries.push(summary);
        }
      } else if (
        isLegacySessionFile(clientEntry)
      ) {
        const summary =
          await readSessionSummary(
            clientEntry.path,
            clientEntry.sha
          );

        if (summary) {
          summary.kind = "history";
          summaries.push(summary);
        }
      }
    }
  }

  const retained =
    applyRetention(summaries);

  return normalizeIndex({
    sessions: retained.kept
  });
}

async function loadSessionIndex() {
  const indexFile =
    await fetchGitHubJson(INDEX_PATH);

  if (indexFile.exists) {
    const normalized = normalizeIndex(
      indexFile.data
    );

    if (normalized.sessions.length > 0) {
      return normalized;
    }
  }

  const rebuiltIndex =
    await buildIndexFromRepository();

  if (rebuiltIndex.sessions.length > 0) {
    await saveSessionIndex(rebuiltIndex);
  }

  return rebuiltIndex;
}

async function saveSessionIndex(indexData) {
  const currentIndex =
    await fetchGitHubJson(INDEX_PATH);
  const nextIndex = normalizeIndex({
    ...indexData,
    updatedAt:
      new Date().toISOString()
  });

  await putGitHubJson(
    INDEX_PATH,
    nextIndex,
    "Update session index",
    currentIndex.exists
      ? currentIndex.sha
      : undefined
  );
}

async function computeSessionSignature(
  sessionData
) {
  const normalized = sessionData.windows.map(
    (windowData) =>
      windowData.tabs.map((tab) => ({
        title: tab.title || "",
        url: tab.url || "",
        active: Boolean(tab.active)
      }))
  );

  const encoded = new TextEncoder().encode(
    JSON.stringify({
      browserAlias:
        sessionData.browserAlias,
      windows: normalized
    })
  );
  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      encoded
    );

  return Array.from(
    new Uint8Array(digest)
  )
    .map((byte) =>
      byte.toString(16).padStart(2, "0")
    )
    .join("");
}

function isSameCalendarDay(
  isoA,
  isoB
) {
  if (!isoA || !isoB) {
    return false;
  }

  return (
    isoA.slice(0, 10) ===
    isoB.slice(0, 10)
  );
}

async function saveSessionToGitHub(
  options = {}
) {
  try {
    const clientId =
      await initializeClientId();
    const profileStorageKey =
      await getProfileStorageKey();
    const { profileName } =
      await chrome.storage.sync.get(
        "profileName"
      );
    const alias =
      profileName || "Default Browser";
    const forceSnapshot = Boolean(
      options.forceSnapshot
    );

    const windows =
      await chrome.windows.getAll({
        populate: true
      });
    const sessionData = {
      timestamp:
        new Date().toISOString(),
      browserAlias: alias,
      profileKey: profileStorageKey,
      clientId,
      windows: windows
        .map((windowData) => ({
          id: windowData.id,
          tabs: windowData.tabs
            .filter(
              (tab) =>
                tab.url !== "chrome://newtab/"
            )
            .map((tab) => ({
              title: tab.title,
              url: tab.url,
              active: tab.active
            }))
        }))
        .filter(
          (windowData) =>
            windowData.tabs.length > 0
        )
    };

    const signature =
      await computeSessionSignature(
        sessionData
      );
    const latestPath = `${SESSIONS_DIR}/${profileStorageKey}/latest.json`;
    const latestFile =
      await fetchGitHubJson(latestPath);
    const latestSignature =
      latestFile.exists
        ? latestFile.data.signature
        : null;
    const hasChanged =
      latestSignature !== signature;

    if (!hasChanged && !forceSnapshot) {
      await chrome.storage.sync.set({
        lastSyncTime:
          new Date().toISOString(),
        lastSyncStatus: "success"
      });
      return {
        success: true,
        skipped: true,
        message:
          "Session unchanged; latest state is already up to date."
      };
    }

    sessionData.signature = signature;
    const historyPath = `${SESSIONS_DIR}/${profileStorageKey}/history/session-${Date.now()}.json`;

    const latestResponse =
      await putGitHubJson(
      latestPath,
      sessionData,
      `Update latest session for ${alias}`,
      latestFile.exists
        ? latestFile.sha
        : undefined
      );
    const currentIndex =
      await loadSessionIndex();
    const latestSummary =
      buildSessionSummary(
        sessionData,
        latestPath,
        latestResponse.content.sha,
        "latest"
      );
    const currentProfileHistory =
      currentIndex.sessions
        .filter(
          (session) =>
            session.profileKey ===
              profileStorageKey &&
            session.kind === "history"
        )
        .sort(
          (a, b) =>
            new Date(b.timestamp) -
            new Date(a.timestamp)
        );
    const mostRecentSnapshot =
      currentProfileHistory[0];
    const shouldCreateDailySnapshot =
      forceSnapshot ||
      !mostRecentSnapshot ||
      !isSameCalendarDay(
        mostRecentSnapshot.timestamp,
        sessionData.timestamp
      );

    let historySummary = null;

    if (shouldCreateDailySnapshot) {
      const historyResponse =
        await putGitHubJson(
          historyPath,
          sessionData,
          `Save session snapshot from ${alias} at ${sessionData.timestamp}`
        );

      historySummary =
        buildSessionSummary(
          sessionData,
          historyPath,
          historyResponse.content.sha,
          "history"
        );
    }

    const withoutDuplicatePath =
      currentIndex.sessions.filter(
        (session) =>
          session.path !== historyPath &&
          session.path !== latestPath
      );
    const retained = applyRetention(
      [
        latestSummary,
        ...(historySummary
          ? [historySummary]
          : []),
        ...withoutDuplicatePath
      ]
    );

    await saveSessionIndex({
      sessions: retained.kept
    });

    for (const staleSession of retained.pruned) {
      try {
        await deleteGitHubFile(
          staleSession.path,
          staleSession.sha,
          `Prune old session snapshot ${staleSession.path}`
        );
      } catch (error) {
        console.warn(
          "Failed to prune old session:",
          staleSession.path,
          error
        );
      }
    }

    await chrome.storage.sync.set({
      lastSyncTime:
        new Date().toISOString(),
      lastSyncStatus: "success"
    });

    console.log(
      "Session saved successfully:",
      historyPath
    );
    return {
      success: true,
      filePath: shouldCreateDailySnapshot
        ? historyPath
        : latestPath,
      latestPath,
      snapshotCreated:
        shouldCreateDailySnapshot,
      snapshotReason: forceSnapshot
        ? "manual"
        : shouldCreateDailySnapshot
          ? "daily"
          : "none"
    };
  } catch (error) {
    console.error(
      "Error saving session:",
      error
    );
    await chrome.storage.sync.set({
      lastSyncTime:
        new Date().toISOString(),
      lastSyncStatus: `error: ${error.message}`
    });
    return {
      success: false,
      error: error.message
    };
  }
}

async function listAllSessions() {
  try {
    const index =
      await loadSessionIndex();

    return {
      success: true,
      sessions: [...index.sessions].sort(
        (a, b) =>
          new Date(b.timestamp) -
          new Date(a.timestamp)
      )
    };
  } catch (error) {
    console.error(
      "Error listing sessions:",
      error
    );
    return {
      success: false,
      sessions: [],
      error: error.message
    };
  }
}

/**
 * Restore a session from GitHub by opening all tabs in windows
 */
async function restoreSession(
  sessionPath
) {
  try {
    const file =
      await fetchGitHubJson(sessionPath);

    if (!file.exists) {
      throw new Error(
        "Session file not found"
      );
    }

    const sessionData = file.data;

    for (const windowData of sessionData.windows) {
      const urls = windowData.tabs
        .map((tab) => tab.url)
        .filter(
          (url) =>
            url &&
            url.startsWith("http")
        );

      if (urls.length > 0) {
        await chrome.windows.create({
          url: urls
        });
      }
    }

    return {
      success: true,
      sessionRestored:
        sessionData.browserAlias
    };
  } catch (error) {
    console.error(
      "Error restoring session:",
      error
    );
    return {
      success: false,
      error: error.message
    };
  }
}

async function getSessionDetails(
  sessionPath
) {
  if (!sessionPath) {
    throw new Error(
      "Session path is required"
    );
  }

  const sessionFile =
    await fetchGitHubJson(sessionPath);

  if (!sessionFile.exists) {
    throw new Error(
      "Session file not found"
    );
  }

  return {
    success: true,
    session: sessionFile.data
  };
}

/**
 * Setup periodic sync using alarms
 */
async function setupSyncAlarm(
  intervalMinutes
) {
  if (intervalMinutes > 0) {
    await chrome.alarms.create(
      "sessionSync",
      {
        periodInMinutes: intervalMinutes
      }
    );
    console.log(
      `Sync alarm set to ${intervalMinutes} minutes`
    );
  } else {
    await chrome.alarms.clear(
      "sessionSync"
    );
    console.log("Sync alarm disabled");
  }
}

/**
 * Alarm listener for periodic syncing
 */
chrome.alarms.onAlarm.addListener(
  async (alarm) => {
    if (alarm.name === "sessionSync") {
      console.log(
        "Running scheduled sync..."
      );
      await saveSessionToGitHub();
    }
  }
);

/**
 * Handle extension installation
 */
chrome.runtime.onInstalled.addListener(
  async (details) => {
    if (details.reason === "install") {
      await initializeClientId();
      chrome.runtime.openOptionsPage();
    }
  }
);

// Initialize on service worker startup
(async () => {
  try {
    const clientId =
      await initializeClientId();
    console.log(
      "Service Worker initialized successfully with clientId:",
      clientId
    );
  } catch (error) {
    console.error(
      "Service Worker initialization failed:",
      error
    );
  }
})();
