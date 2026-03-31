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
const MAX_HISTORY_PER_CLIENT = 30;

console.log(
  "Service Worker: Initializing..."
);

/**
 * Utility to wait for X ms
 */
function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

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
        forceSnapshot: true,
        friendlyName: request.friendlyName || null,
        pinned: request.pinned || false
      });

    case "renameSession":
      console.log("Processing renameSession");
      return await handleRenameSession(
        request.sessionPath,
        request.newName
      );

    case "toggleSessionPin":
      console.log("Processing toggleSessionPin");
      return await handleToggleSessionPin(
        request.sessionPath,
        request.isPinned
      );

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

    case "setupTimeline":
      console.log("Processing setupTimeline");
      await setupTimelineAlarm(request.intervalMinutes);
      return { success: true };

    case "archiveSessionManually":
      console.log(
        "Processing archiveSessionManually"
      );
      return await handleManualArchive(
        request.sessionSummary
      );

    case "deleteSession":
      console.log(
        "Processing deleteSession"
      );
      return await handleManualDelete(
        request.sessionSummary,
        request.isFromArchive
      );

    case "searchArchive":
      console.log(
        "Processing searchArchive"
      );
      return await handleArchiveSearch(
        request
      );

    case "unarchiveSession":
      console.log("Processing unarchiveSession");
      return await handleUnarchiveSession(
        request.sessionSummary
      );

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

  // Priority: 1. Explicit profileKey, 2. Slugified profileName, 3. Local clientId (fallback)
  const normalizedKey =
    slugifyProfileKey(profileKey) ||
    slugifyProfileKey(profileName);

  // If we have a named profile, ensure it's synced.
  if (normalizedKey && normalizedKey !== profileKey) {
    await chrome.storage.sync.set({
      profileKey: normalizedKey
    });
    return normalizedKey;
  }

  // If no name is provided, use the LOCAL clientId and do NOT sync it.
  return normalizedKey || clientId;
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
    { headers, cache: "no-store" }
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
    { headers, cache: "no-store" }
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

  for (let attempt = 0; attempt < 3; attempt++) {
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
    
    // Check for SHA mismatch or generic update conflict
    const isConflict =
      response.status === 409 ||
      response.status === 422 ||
      errorMessage.toLowerCase().includes("sha") ||
      errorMessage.toLowerCase().includes("conflict") ||
      errorMessage.toLowerCase().includes("expected");

    const shouldRetry = attempt < 2 && isConflict;

    if (!shouldRetry) {
      throw new Error(errorMessage);
    }

    console.warn(
      `Conflict detected on ${path} (Attempt ${attempt + 1}), retrying with fresh SHA...`
    );

    // Random jitter between 200ms and 1500ms to resolve races
    await sleep(200 + Math.random() * 1300);

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
  let currentSha = sha;

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(
      `${repoUrl}/contents/${path}`,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          message,
          sha: currentSha
        })
      }
    );

    if (response.ok || response.status === 404) {
      return;
    }

    const errorMessage =
      await parseGitHubError(response);
    
    // Check for SHA mismatch
    const isConflict =
      response.status === 409 ||
      response.status === 422 ||
      errorMessage.toLowerCase().includes("sha") ||
      errorMessage.toLowerCase().includes("conflict") ||
      errorMessage.toLowerCase().includes("expected");

    const shouldRetry = attempt < 2 && isConflict;

    if (!shouldRetry) {
      throw new Error(errorMessage);
    }

    console.warn(
      `Conflict detected on delete ${path} (Attempt ${attempt + 1}), retrying...`
    );

    // Random jitter before retry
    await sleep(200 + Math.random() * 1300);

    const existingFile =
      await fetchGitHubJson(path);
    if (!existingFile.exists) {
      return;
    }
    currentSha = existingFile.sha;
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
    friendlyName: sessionData.friendlyName || null,
    pinned: sessionData.pinned || false,
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
  sessionEntries,
  timelineRetentionDays = 2
) {
  const pinned = sessionEntries.filter(
    (session) => session.kind === "latest" || session.pinned
  );
  const historyEntries =
    sessionEntries.filter(
      (session) => session.kind !== "latest" && !session.pinned
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
    if (session.kind === "timeline") {
      const today = new Date();
      const sessionDate = new Date(session.timestamp);
      today.setHours(0,0,0,0);
      sessionDate.setHours(0,0,0,0);
      const diffTime = today - sessionDate;
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays < timelineRetentionDays) {
        keptHistory.push(session);
      } else {
        pruned.push(session);
      }
      continue;
    }

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
    const isTimeline = Boolean(
      options.isTimeline
    );
    const friendlyName = options.friendlyName || null;
    const pinned = Boolean(options.pinned);

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
      friendlyName,
      pinned,
      isTimeline,
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
              url: tab.url || tab.pendingUrl || "",
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

    sessionData.signature = signature;
    const historyPath = isTimeline 
      ? `${SESSIONS_DIR}/${profileStorageKey}/history/timeline/session-${Date.now()}.json`
      : `${SESSIONS_DIR}/${profileStorageKey}/history/session-${Date.now()}.json`;

    const latestSessionData = {
      ...sessionData,
      isTimeline: undefined,
      friendlyName: null,
      pinned: false
    };

    let latestSummary = null;

    // 1. Collaborative Skip Detection:
    // If global state matches (nothing changed since last sync) AND this is a Timeline sync,
    // we can skip the entire process because the timeline already has this state.
    if (!hasChanged && isTimeline && !forceSnapshot) {
      await chrome.storage.sync.set({
        lastSyncTime: new Date().toISOString(),
        lastSyncStatus: "success"
      });
      return { success: true, skipped: true, message: "Timeline is already up to date." };
    }

    // 2. Global Baseline Update:
    // Update latest.json ONLY if there's a global change.
    if (hasChanged || forceSnapshot) {
      const latestResponse = await putGitHubJson(
        latestPath,
        latestSessionData,
        isTimeline ? `Update baseline (Timeline pulse) for ${alias}` : `Update latest session for ${alias}`,
        latestFile.exists ? latestFile.sha : undefined
      );

      latestSummary = buildSessionSummary(
        latestSessionData,
        latestPath,
        latestResponse.content.sha,
        "latest"
      );
    }

    const currentIndex = await loadSessionIndex();
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
    const mostRecentUnpinnedSnapshot =
      currentProfileHistory.find(s => !s.pinned && !s.friendlyName);

    const mostRecentDailySignature = mostRecentUnpinnedSnapshot?.signature || null;
    const dailyNeedsUpdate = signature !== mostRecentDailySignature;

    const isSameDay = 
      mostRecentUnpinnedSnapshot && 
      !forceSnapshot && 
      !isTimeline &&
      isSameCalendarDay(
        mostRecentUnpinnedSnapshot.timestamp,
        sessionData.timestamp
      );
      
    // Dual Save Logic:
    // 1. If global state changed (or forced), we ALWAYS create a Timeline pulse.
    const createTimelinePulse = hasChanged || forceSnapshot;

    // 2. If it's a Normal Sync, we update/create the History entry if current state is missing from history.
    const updateDailyHistory = !isTimeline && (dailyNeedsUpdate || forceSnapshot);

    let historySummary = null;
    let timelineSummary = null;

    // A. Handle Timeline/Pulse creation
    if (createTimelinePulse) {
      const timelinePath = `${SESSIONS_DIR}/${profileStorageKey}/history/timeline/session-${Date.now()}.json`;
      const timelineResponse =
        await putGitHubJson(
          timelinePath,
          sessionData,
          `Create timeline pulse for ${alias}`
        );

      timelineSummary =
        buildSessionSummary(
          sessionData,
          timelinePath,
          timelineResponse.content.sha,
          "timeline"
        );
    }

    // B. Handle Daily History creation/update
    let finalHistoryPath = historyPath;
    if (updateDailyHistory) {
      if (!isSameDay || forceSnapshot) {
        // Create new daily snapshot if today is new
        const historyResponse =
          await putGitHubJson(
            historyPath,
            sessionData,
            `Create daily snapshot for ${alias}`
          );

        historySummary =
          buildSessionSummary(
            sessionData,
            historyPath,
            historyResponse.content.sha,
            "history"
          );
      } else {
        // Update today's existing snapshot
        finalHistoryPath = mostRecentUnpinnedSnapshot.path;
        const historyResponse =
          await putGitHubJson(
            finalHistoryPath,
            sessionData,
            `Update daily snapshot for ${alias}`,
            mostRecentUnpinnedSnapshot.sha
          );

        historySummary =
          buildSessionSummary(
            sessionData,
            finalHistoryPath,
            historyResponse.content.sha,
            "history"
          );
      }
    }


    const withoutDuplicatePath =
      currentIndex.sessions.filter(
        (session) =>
          session.path !== finalHistoryPath &&
          session.path !== latestPath &&
          (!timelineSummary || session.path !== timelineSummary.path)
      );
    const oldLatest = currentIndex.sessions.find(s => s.profileKey === profileStorageKey && s.kind === "latest");
    const summaryToKeep = latestSummary || oldLatest;

    const { timelineRetention } = await chrome.storage.sync.get({ timelineRetention: 2 });

    const retained = applyRetention([
      ...(summaryToKeep ? [summaryToKeep] : []),
      ...(historySummary ? [historySummary] : []),
      ...(timelineSummary ? [timelineSummary] : []),
      ...withoutDuplicatePath
    ], timelineRetention);

    await saveSessionIndex({
      sessions: retained.kept
    });

    for (const staleSession of retained.pruned) {
      try {
        await archiveSession(staleSession);
      } catch (error) {
        console.warn(
          "Failed to archive old session:",
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
      finalHistoryPath
    );
    return {
      success: true,
      filePath: updateDailyHistory
        ? finalHistoryPath
        : latestPath,
      latestPath,
      snapshotCreated:
        createTimelinePulse || updateDailyHistory,
      snapshotReason: forceSnapshot
        ? "manual"
        : updateDailyHistory
          ? "daily"
          : createTimelinePulse
            ? "pulse"
            : "update"
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
 * Setup periodic timeline using alarms
 */
async function setupTimelineAlarm(intervalMinutes) {
  if (intervalMinutes > 0) {
    await chrome.alarms.create("timelineSync", {
      periodInMinutes: intervalMinutes
    });
    console.log(`Timeline alarm set to ${intervalMinutes} minutes`);
  } else {
    await chrome.alarms.clear("timelineSync");
    console.log("Timeline alarm disabled");
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
    } else if (alarm.name === "timelineSync") {
      console.log("Running scheduled timeline sync...");
      await saveSessionToGitHub({ isTimeline: true });
    }
  }
);

/**
 * Move a session from history to archive.
 */
async function archiveSession(sessionSummary) {
  const profileKey =
    sessionSummary.profileKey || "unknown";
  const date = new Date(
    sessionSummary.timestamp
  );
  const year = date.getUTCFullYear();
  const month = String(
    date.getUTCMonth() + 1
  ).padStart(2, "0");
  const filename = sessionSummary.path
    .split("/")
    .pop();
  const archivePath = `${SESSIONS_DIR}/${profileKey}/archive/${year}/${month}/${filename}`;
  const archiveIndexPath = `${SESSIONS_DIR}/${profileKey}/archive/archive_index.json`;

  // 1. Fetch the data if it's not already in the summary (summary is just metadata).
  const sessionFile =
    await fetchGitHubJson(
      sessionSummary.path
    );

  if (!sessionFile.exists) {
    console.warn(
      `Session file ${sessionSummary.path} no longer exists; skipping archive.`
    );
    return;
  }

  const sessionDataToArchive = {
    ...sessionFile.data,
    pinned: false
  };

  // 2. Put into archive.
  await putGitHubJson(
    archivePath,
    sessionDataToArchive,
    `Archive session snapshot ${filename} to ${year}/${month}`
  );

  // 3. Update archive index.
  const archiveIndexFile =
    await fetchGitHubJson(
      archiveIndexPath
    );
  const archiveIndex =
    archiveIndexFile.exists
      ? archiveIndexFile.data
      : { sessions: [] };

  const newSummary = {
    ...sessionSummary,
    path: archivePath,
    pinned: false,
    sha: undefined // SHA will be fresh in archive.
  };

  archiveIndex.sessions.push(newSummary);
  // Keep index sorted by timestamp (newest first).
  archiveIndex.sessions.sort(
    (a, b) =>
      new Date(b.timestamp) -
      new Date(a.timestamp)
  );

  await putGitHubJson(
    archiveIndexPath,
    archiveIndex,
    `Update archive index for ${year}/${month}`,
    archiveIndexFile.exists
      ? archiveIndexFile.sha
      : undefined
  );

  // 4. Delete the original history file.
  await deleteGitHubFile(
    sessionSummary.path,
    sessionFile.sha,
    `Delete archived session from history: ${filename}`
  );

  console.log(
    `Archived ${sessionSummary.path} to ${archivePath}`
  );
}

async function handleManualArchive(
  sessionSummary
) {
  try {
    // 1. Perform the archive move.
    await archiveSession(sessionSummary);

    // 2. Remove from the active index.
    const index = await loadSessionIndex();
    index.sessions =
      index.sessions.filter(
        (s) => s.path !== sessionSummary.path
      );

    await saveSessionIndex(index);

    return { success: true };
  } catch (error) {
    console.error(
      "Manual archive failed:",
      error
    );
    return {
      success: false,
      error: error.message
    };
  }
}

async function handleUnarchiveSession(sessionSummary) {
  try {
    const profileKey =
      sessionSummary.profileKey ||
      (await getProfileStorageKey());
    const filename = sessionSummary.path.split("/").pop();
    const historyPath = `${SESSIONS_DIR}/${profileKey}/history/${filename}`;
    const archiveIndexPath = `${SESSIONS_DIR}/${profileKey}/archive/archive_index.json`;

    // 1. Fetch from archive
    const sessionFile = await fetchGitHubJson(sessionSummary.path);
    if (!sessionFile.exists) throw new Error("Archived session file missing");

    // 2. Put back to history without pinning
    const sessionData = { ...sessionFile.data, pinned: false };
    const historyResponse = await putGitHubJson(
      historyPath,
      sessionData,
      `Unarchive session: ${filename}`
    );

    // 3. Remove from archive_index
    const archiveIndexFile = await fetchGitHubJson(archiveIndexPath);
    if (archiveIndexFile.exists) {
      const archiveIndex = archiveIndexFile.data;
      archiveIndex.sessions = archiveIndex.sessions.filter(
        (s) => s.path !== sessionSummary.path
      );
      await putGitHubJson(
        archiveIndexPath,
        archiveIndex,
        "Update archive index after unarchiving",
        archiveIndexFile.sha
      );
    }

    // 4. Delete the file from archive folder
    await deleteGitHubFile(
      sessionSummary.path,
      sessionFile.sha,
      `Delete unarchived session from archive: ${filename}`
    );

    // 5. Add to active index
    const index = await loadSessionIndex();
    const newSummary = {
      ...sessionSummary,
      path: historyPath,
      pinned: false,
      sha: historyResponse.content.sha
    };
    
    // remove any duplicates just in case
    index.sessions = index.sessions.filter(s => s.path !== historyPath);
    index.sessions.push(newSummary);
    index.sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    await saveSessionIndex(index);

    return { success: true };
  } catch (error) {
    console.error("Unarchive failed:", error);
    return { success: false, error: error.message };
  }
}

async function handleManualDelete(
  sessionSummary,
  isFromArchive = false
) {
  try {
    // 1. Delete the file from GitHub.
    const file = await fetchGitHubJson(
      sessionSummary.path
    );
    if (file.exists) {
      await deleteGitHubFile(
        sessionSummary.path,
        file.sha,
        `Manual delete of session: ${sessionSummary.path}`
      );
    }

    // 2. Remove from the appropriate index.
    if (isFromArchive) {
      const profileKey =
        sessionSummary.profileKey ||
        (await getProfileStorageKey());
      const archiveIndexPath = `${SESSIONS_DIR}/${profileKey}/archive/archive_index.json`;
      const archiveIndexFile =
        await fetchGitHubJson(
          archiveIndexPath
        );

      if (archiveIndexFile.exists) {
        const archiveIndex =
          archiveIndexFile.data;
        archiveIndex.sessions =
          archiveIndex.sessions.filter(
            (s) =>
              s.path !== sessionSummary.path
          );
        await putGitHubJson(
          archiveIndexPath,
          archiveIndex,
          "Update archive index after manual delete",
          archiveIndexFile.sha
        );
      }
    } else {
      const index = await loadSessionIndex();
      index.sessions =
        index.sessions.filter(
          (s) =>
            s.path !== sessionSummary.path
        );
      await saveSessionIndex(index);
    }

    return { success: true };
  } catch (error) {
    console.error(
      "Manual delete failed:",
      error
    );
    return {
      success: false,
      error: error.message
    };
  }
}

async function handleArchiveSearch(request) {
  let profileKeys = [];

  if (request.profileKey) {
    profileKeys = [request.profileKey];
  } else {
    // List all potential profiles from SESSIONS_DIR.
    const rootDir = await listGitHubDirectory(
      SESSIONS_DIR
    );
    if (rootDir.exists) {
      profileKeys = rootDir.entries
        .filter((e) => e.type === "dir")
        .map((e) => e.name);
    }
  }

  let allArchivedSessions = [];

  for (const profileKey of profileKeys) {
    const archiveIndexPath = `${SESSIONS_DIR}/${profileKey}/archive/archive_index.json`;
    const archiveIndexFile =
      await fetchGitHubJson(archiveIndexPath);

    if (archiveIndexFile.exists) {
      const sessions =
        archiveIndexFile.data.sessions || [];
      allArchivedSessions.push(...sessions);
    }
  }

  if (allArchivedSessions.length === 0) {
    return { success: true, sessions: [] };
  }

  // Sort all sessions by timestamp (newest first).
  allArchivedSessions.sort(
    (a, b) =>
      new Date(b.timestamp) -
      new Date(a.timestamp)
  );

  let results = allArchivedSessions;

  if (request.query) {
    const q = request.query.toLowerCase();
    results = results.filter((s) => {
      const searchText = (
        s.searchText || ""
      ).toLowerCase();
      return (
        searchText.includes(q) ||
        (s.browserAlias || "")
          .toLowerCase()
          .includes(q) ||
        (s.timestamp || "").includes(q)
      );
    });
  }

  // Limit results.
  return {
    success: true,
    sessions: results.slice(0, 100)
  };
}

async function handleRenameSession(sessionPath, newName) {
  try {
    const file = await fetchGitHubJson(sessionPath);
    if (!file.exists) throw new Error("Session file not found");

    const sessionData = file.data;
    sessionData.friendlyName = newName || null;

    const response = await putGitHubJson(
      sessionPath,
      sessionData,
      `Rename session to ${newName || "default"}`,
      file.sha
    );

    const isArchived = sessionPath.includes("/archive/");
    const profileKey = sessionPath.split("/")[1];

    if (isArchived) {
      const archiveIndexPath = `${SESSIONS_DIR}/${profileKey}/archive/archive_index.json`;
      const archiveIndexFile = await fetchGitHubJson(archiveIndexPath);
      if (archiveIndexFile.exists) {
        const sessionIndex = archiveIndexFile.data.sessions.findIndex(s => s.path === sessionPath);
        if (sessionIndex !== -1) {
          archiveIndexFile.data.sessions[sessionIndex].friendlyName = sessionData.friendlyName;
          await putGitHubJson(
            archiveIndexPath,
            archiveIndexFile.data,
            `Rename archived session summary`,
            archiveIndexFile.sha
          );
        }
      }
    } else {
      const index = await loadSessionIndex();
      const sessionIndex = index.sessions.findIndex(s => s.path === sessionPath);
      if (sessionIndex !== -1) {
        index.sessions[sessionIndex].friendlyName = sessionData.friendlyName;
        await saveSessionIndex(index);
      }
    }
    return { success: true };
  } catch (error) {
    console.error("Error renaming session", error);
    return { success: false, error: error.message };
  }
}

async function handleToggleSessionPin(sessionPath, isPinned) {
  try {
    const file = await fetchGitHubJson(sessionPath);
    if (!file.exists) throw new Error("Session file not found");

    const sessionData = file.data;
    sessionData.pinned = isPinned;

    const response = await putGitHubJson(
      sessionPath,
      sessionData,
      `${isPinned ? "Pin" : "Unpin"} session`,
      file.sha
    );

    const isArchived = sessionPath.includes("/archive/");
    const profileKey = sessionPath.split("/")[1];

    if (isArchived) {
      const archiveIndexPath = `${SESSIONS_DIR}/${profileKey}/archive/archive_index.json`;
      const archiveIndexFile = await fetchGitHubJson(archiveIndexPath);
      if (archiveIndexFile.exists) {
        const sessionIndex = archiveIndexFile.data.sessions.findIndex(s => s.path === sessionPath);
        if (sessionIndex !== -1) {
          archiveIndexFile.data.sessions[sessionIndex].pinned = sessionData.pinned;
          await putGitHubJson(
            archiveIndexPath,
            archiveIndexFile.data,
            `Toggle pin on archived session summary`,
            archiveIndexFile.sha
          );
        }
      }
    } else {
      const index = await loadSessionIndex();
      const sessionIndex = index.sessions.findIndex(s => s.path === sessionPath);
      if (sessionIndex !== -1) {
        index.sessions[sessionIndex].pinned = sessionData.pinned;
        await saveSessionIndex(index);
      }
    }
    return { success: true };
  } catch (error) {
    console.error("Error toggling pin", error);
    return { success: false, error: error.message };
  }
}

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
