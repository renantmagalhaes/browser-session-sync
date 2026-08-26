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
const MAX_SAVED_PER_PROFILE = 30;
const MAX_WRITE_ATTEMPTS = 7;

let mutationQueue = Promise.resolve();

function enqueueMutation(task) {
  const operation = mutationQueue.then(task, task);
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

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
      return await enqueueMutation(() => handleRenameSession(
        request.sessionPath,
        request.newName
      ));

    case "toggleSessionPin":
      console.log("Processing toggleSessionPin");
      return await enqueueMutation(() => handleToggleSessionPin(
        request.sessionPath,
        request.isPinned
      ));

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

    case "runRetention":
      return await enqueueMutation(() => reconcileRepositoryRetention());

    case "archiveSessionManually":
      console.log(
        "Processing archiveSessionManually"
      );
      return await enqueueMutation(() => handleManualArchive(
        request.sessionSummary
      ));

    case "deleteSession":
      console.log(
        "Processing deleteSession"
      );
      return await enqueueMutation(() => handleManualDelete(
        request.sessionSummary,
        request.isFromArchive
      ));

    case "searchArchive":
      console.log(
        "Processing searchArchive"
      );
      return await handleArchiveSearch(
        request
      );

    case "unarchiveSession":
      console.log("Processing unarchiveSession");
      return await enqueueMutation(() => handleUnarchiveSession(
        request.sessionSummary
      ));

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

function normalizeProfileName(value) {
  return (value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function getProfileStorageKey() {
  const clientId =
    await initializeClientId();
  const { profileKey } = await chrome.storage.sync.get("profileKey");
  const profileName = await getProfileDisplayName();

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

async function getProfileDisplayName() {
  const local = await chrome.storage.local.get("profileName");
  if (local.profileName) return local.profileName.trim().replace(/\s+/g, " ");

  // Migrate the pre-1.4.6 value. Profile names must be local so computers
  // sharing a Chrome account and Profile Folder can retain distinct aliases.
  const legacy = await chrome.storage.sync.get("profileName");
  if (legacy.profileName) {
    await chrome.storage.local.set({ profileName: legacy.profileName });
    return legacy.profileName.trim().replace(/\s+/g, " ");
  }
  return "";
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

  let content = payload.content;
  if (payload.size > 0 && (!content || payload.encoding === "none") && payload.sha) {
    console.log(
      `File ${path} is larger than 1MB (size: ${payload.size} bytes). Fetching content via Git Blobs API...`
    );
    const blobResponse = await fetch(
      `${repoUrl}/git/blobs/${payload.sha}`,
      { headers }
    );
    if (!blobResponse.ok) {
      throw new Error(
        `Failed to fetch blob for file larger than 1MB: ${await parseGitHubError(blobResponse)}`
      );
    }
    const blobPayload = await blobResponse.json();
    content = blobPayload.content;
  }

  return {
    exists: true,
    sha: payload.sha,
    data: JSON.parse(
      decodeBase64Utf8(content || "")
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
  sha,
  options = {}
) {
  const repoUrl = await getRepoUrl();
  const headers =
    await getGitHubHeaders();
  let currentSha = sha;
  const maxAttempts = options.maxAttempts || MAX_WRITE_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let dataToWrite = data;
    if (options.conflictResolver) {
      const existingFile = await fetchGitHubJson(path);
      currentSha = existingFile.exists ? existingFile.sha : undefined;
      dataToWrite = await options.conflictResolver(
        existingFile.exists ? existingFile.data : null,
        existingFile.exists,
        attempt
      );
    }

    const response = await fetch(
      `${repoUrl}/contents/${path}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          message,
          content: encodeBase64Utf8(
            JSON.stringify(dataToWrite, null, 2)
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

    const shouldRetry = attempt < maxAttempts - 1 && isConflict;

    if (!shouldRetry) {
      throw new Error(errorMessage);
    }

    console.warn(
      `Conflict detected on ${path} (Attempt ${attempt + 1}), retrying with fresh SHA...`
    );

    // Random jitter between 200ms and 1500ms to resolve races
    await sleep(
      Math.min(5000, 250 * 2 ** attempt) + Math.random() * 750
    );

    if (!options.conflictResolver) {
      const existingFile = await fetchGitHubJson(path);
      currentSha = existingFile.exists ? existingFile.sha : undefined;
    }
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

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
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

    const shouldRetry = attempt < MAX_WRITE_ATTEMPTS - 1 && isConflict;

    if (!shouldRetry) {
      throw new Error(errorMessage);
    }

    console.warn(
      `Conflict detected on delete ${path} (Attempt ${attempt + 1}), retrying...`
    );

    // Random jitter before retry
    await sleep(
      Math.min(5000, 250 * 2 ** attempt) + Math.random() * 750
    );

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

  const normalizedSessions = sessions
    .filter(
      (session) =>
        session &&
        session.path &&
        session.timestamp
    )
    .map((session) => {
      const inferredProfileKey =
        session.profileKey ||
        (!session.path.startsWith(`${SESSIONS_DIR}/`)
          ? session.path.split("/")[0]
          : "");
      return {
        ...session,
        path: inferredProfileKey
          ? canonicalizeSessionPath(session.path, inferredProfileKey)
          : session.path,
        previewTabs: Array.isArray(session.previewTabs)
          ? session.previewTabs
          : [],
        searchText: session.searchText || ""
      };
    });
  const sessionsByPath = new Map();
  for (const session of normalizedSessions) {
    const existing = sessionsByPath.get(session.path);
    if (
      !existing ||
      new Date(session.timestamp) >= new Date(existing.timestamp)
    ) {
      sessionsByPath.set(session.path, session);
    }
  }

  return {
    version: 2,
    updatedAt:
      indexData?.updatedAt || null,
    sessions: [...sessionsByPath.values()]
  };
}

function canonicalizeSessionPath(sessionPath, profileKey) {
  if (!sessionPath || sessionPath.startsWith(`${SESSIONS_DIR}/`)) {
    return sessionPath;
  }
  if (sessionPath.startsWith(`${profileKey}/`)) {
    return `${SESSIONS_DIR}/${sessionPath}`;
  }
  return `${SESSIONS_DIR}/${profileKey}/${sessionPath.replace(/^\/+/, "")}`;
}

function normalizeArchiveIndex(profileKey, indexData) {
  return {
    ...(indexData || {}),
    sessions: (Array.isArray(indexData?.sessions) ? indexData.sessions : [])
      .filter((session) => session?.path && session?.timestamp)
      .map((session) => ({
        ...session,
        profileKey: session.profileKey || profileKey,
        path: canonicalizeSessionPath(session.path, profileKey),
        previewTabs: Array.isArray(session.previewTabs)
          ? session.previewTabs
          : [],
        searchText: session.searchText || ""
      }))
  };
}

async function mutateSessionIndex(mutator, message) {
  let finalIndex;
  await putGitHubJson(
    INDEX_PATH,
    null,
    message,
    undefined,
    {
      conflictResolver: (currentData) => {
        const currentIndex = normalizeIndex(currentData || { sessions: [] });
        finalIndex = normalizeIndex(
          mutator(currentIndex) || currentIndex
        );
        finalIndex.updatedAt = new Date().toISOString();
        return finalIndex;
      }
    }
  );
  return finalIndex;
}

async function mutateArchiveIndex(profileKey, mutator, message) {
  const archiveIndexPath = `${SESSIONS_DIR}/${profileKey}/archive/archive_index.json`;
  let finalIndex;
  await putGitHubJson(
    archiveIndexPath,
    null,
    message,
    undefined,
    {
      conflictResolver: (currentData) => {
        const currentIndex = normalizeArchiveIndex(profileKey, currentData);
        finalIndex = mutator(currentIndex) || currentIndex;
        const byPath = new Map();
        for (const session of finalIndex.sessions || []) {
          if (session?.path) byPath.set(session.path, session);
        }
        finalIndex.sessions = [...byPath.values()].sort(
          (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
        );
        finalIndex.updatedAt = new Date().toISOString();
        return finalIndex;
      }
    }
  );
  return finalIndex;
}

function buildSearchText(
  sessionData,
  tabs
) {
  return [
    sessionData.browserAlias,
    sessionData.profileKey,
    sessionData.clientId,
    ...(sessionData.timelineSources || []).flatMap((source) => [
      source.browserAlias || "",
      source.clientId || ""
    ]),
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
  const sourceAliasesByName = new Map();
  for (const source of sessionData.timelineSources || []) {
    const alias = source.browserAlias?.trim();
    const normalizedAlias = normalizeProfileName(alias);
    if (normalizedAlias && !sourceAliasesByName.has(normalizedAlias)) {
      sourceAliasesByName.set(normalizedAlias, alias);
    }
  }
  const sourceAliases = [...sourceAliasesByName.values()];

  return {
    path,
    sha,
    kind,
    timestamp: sessionData.timestamp,
    signature: sessionData.signature || null,
    browserAlias: sourceAliases.length > 1
      ? sourceAliases.join(", ")
      : sessionData.browserAlias,
    profileKey:
      sessionData.profileKey || "",
    clientId: sessionData.clientId,
    isManualSnapshot: Boolean(sessionData.isManualSnapshot),
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
  timelineRetentionDays = 10,
  savedRetentionDays = 0,
  timezone
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
  const deleted = [];
  const countByProfile = new Map();

  const sorted = [...historyEntries].sort(
    (a, b) =>
      new Date(b.timestamp) -
      new Date(a.timestamp)
  );

  for (const session of sorted) {
    if (session.kind === "timeline") {
      const todayKey = getLocalDayKey(new Date().toISOString(), timezone);
      const sessionKey = getLocalDayKey(session.timestamp, timezone);
      const diffDays = Math.round(
        (new Date(todayKey + "T00:00:00Z") - new Date(sessionKey + "T00:00:00Z")) / 86400000
      );
      if (diffDays < timelineRetentionDays) {
        keptHistory.push(session);
      } else {
        pruned.push(session);
      }
      continue;
    }

    if (
      session.kind === "history" &&
      savedRetentionDays > 0 &&
      !isWithinRetention(session.timestamp, savedRetentionDays, timezone)
    ) {
      deleted.push(session);
      continue;
    }

    const key =
      session.profileKey ||
      session.clientId ||
      "unknown";
    const count =
      countByProfile.get(key) || 0;

    if (count < MAX_SAVED_PER_PROFILE) {
      keptHistory.push(session);
      countByProfile.set(key, count + 1);
    } else {
      pruned.push(session);
    }
  }

  return {
    kept: [...pinned, ...keptHistory],
    pruned,
    deleted
  };
}

function getLocalDayKey(timestamp, timezone) {
  const date = new Date(timestamp);
  if (!timezone || timezone === "browser") {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
}

function isWithinRetention(timestamp, retentionDays, timezone) {
  const todayKey = getLocalDayKey(new Date().toISOString(), timezone);
  const sessionKey = getLocalDayKey(timestamp, timezone);
  return Math.round(
    (new Date(todayKey + "T00:00:00Z") - new Date(sessionKey + "T00:00:00Z")) / 86400000
  ) < retentionDays;
}

async function buildTimelineArchiveData(
  currentData,
  sourceFiles,
  latest,
  dayKey
) {
  const tabsByUrl = new Map();
  const processedPaths = new Set(
    currentData?.timelineSourcePaths || []
  );

  const addTabs = (sessionData) => {
    for (const windowData of sessionData?.windows || []) {
      for (const tab of windowData.tabs || []) {
        if (!tab.url) continue;
        const existing = tabsByUrl.get(tab.url);
        const firstSeenAt = tab.firstSeenAt || sessionData.timestamp;
        const lastSeenAt = tab.lastSeenAt || sessionData.timestamp;
        tabsByUrl.set(tab.url, {
          title: tab.title || existing?.title || "Untitled",
          url: tab.url,
          active: false,
          firstSeenAt:
            existing?.firstSeenAt &&
            new Date(existing.firstSeenAt) < new Date(firstSeenAt)
              ? existing.firstSeenAt
              : firstSeenAt,
          lastSeenAt:
            existing?.lastSeenAt &&
            new Date(existing.lastSeenAt) > new Date(lastSeenAt)
              ? existing.lastSeenAt
              : lastSeenAt
        });
      }
    }
  };

  addTabs(currentData);
  let addedSnapshots = 0;
  for (const source of sourceFiles) {
    if (!processedPaths.has(source.summary.path)) {
      addTabs(source.data);
      processedPaths.add(source.summary.path);
      addedSnapshots++;
    }
  }

  const currentTimestamp = currentData?.timestamp;
  const latestData =
    currentTimestamp && new Date(currentTimestamp) > new Date(latest.timestamp)
      ? currentData
      : latest;
  const timelineSourcesByClient = new Map();
  const addTimelineSource = (sessionData) => {
    if (!sessionData?.browserAlias && !sessionData?.clientId) return;
    const key = sessionData.clientId || sessionData.browserAlias;
    timelineSourcesByClient.set(key, {
      clientId: sessionData.clientId || null,
      browserAlias: sessionData.browserAlias || "Unknown Browser"
    });
  };
  for (const source of currentData?.timelineSources || []) {
    addTimelineSource(source);
  }
  addTimelineSource(currentData);
  for (const source of sourceFiles) {
    addTimelineSource(source.data);
  }
  const archiveData = {
    ...latestData,
    timestamp: latestData.timestamp,
    isTimeline: false,
    isTimelineArchive: true,
    timelineDate: dayKey,
    timelineSnapshotCount:
      (currentData?.timelineSnapshotCount || 0) + addedSnapshots,
    timelineSourcePaths: [...processedPaths],
    timelineSources: [...timelineSourcesByClient.values()],
    friendlyName: currentData?.friendlyName || null,
    pinned: false,
    windows: [{ id: null, tabs: [...tabsByUrl.values()] }]
  };
  archiveData.signature = await computeSessionSignature(archiveData);
  return archiveData;
}

async function archiveTimelineDay(profileKey, dayKey, sessions) {
  const sourceFiles = [];
  for (const session of sessions) {
    const file = await fetchGitHubJson(session.path);
    if (file.exists) {
      sourceFiles.push({ summary: session, ...file });
    }
  }

  if (sourceFiles.length === 0) return;

  sourceFiles.sort(
    (a, b) => new Date(a.data.timestamp) - new Date(b.data.timestamp)
  );
  const latest = sourceFiles.at(-1).data;
  const [year, month] = dayKey.split("-");
  const archivePath = `${SESSIONS_DIR}/${profileKey}/archive/timeline/${year}/${month}/day-${dayKey}.json`;
  let archiveData;
  const response = await putGitHubJson(
    archivePath,
    null,
    `Archive deduplicated timeline for ${dayKey}`,
    undefined,
    {
      conflictResolver: async (currentData) => {
        archiveData = await buildTimelineArchiveData(
          currentData,
          sourceFiles,
          latest,
          dayKey
        );
        return archiveData;
      }
    }
  );
  const summary = buildSessionSummary(
    archiveData,
    archivePath,
    response.content.sha,
    "timelineArchive"
  );
  await mutateArchiveIndex(profileKey, (index) => ({
    ...index,
    sessions: [
      ...index.sessions.filter((session) => session.path !== archivePath),
      summary
    ]
  }), `Update archive index for ${dayKey}`);

  for (const source of sourceFiles) {
    await deleteGitHubFile(
      source.summary.path,
      source.sha,
      `Archive timeline snapshot into ${dayKey}`
    );
  }
}

async function pruneArchiveForProfile(profileKey, archiveRetentionDays, timezone) {
  const archiveIndexPath = `${SESSIONS_DIR}/${profileKey}/archive/archive_index.json`;
  const archiveIndexFile = await fetchGitHubJson(archiveIndexPath);
  if (!archiveIndexFile.exists) return;

  const archiveIndex = normalizeArchiveIndex(profileKey, archiveIndexFile.data);
  const needsPathMigration = archiveIndex.sessions.some(
    (session, index) =>
      session.path !== archiveIndexFile.data?.sessions?.[index]?.path
  );
  const expired = archiveIndex.sessions.filter(
    (session) => !isWithinRetention(session.timestamp, archiveRetentionDays, timezone)
  );
  if (expired.length === 0) {
    if (needsPathMigration) {
      await mutateArchiveIndex(
        profileKey,
        (index) => index,
        "Normalize legacy archive index paths"
      );
    }
    return;
  }

  for (const session of expired) {
    const file = await fetchGitHubJson(session.path);
    if (file.exists) {
      await deleteGitHubFile(session.path, file.sha, "Delete expired archive snapshot");
    }
  }
  const expiredPaths = new Set(expired.map((session) => session.path));
  await mutateArchiveIndex(profileKey, (index) => ({
    ...index,
    sessions: index.sessions.filter(
      (session) => !expiredPaths.has(session.path)
    )
  }), "Apply archive retention");
}

async function disposePrunedSessions(prunedSessions) {
  const { archiveRetention, userTimezone } = await chrome.storage.sync.get({
    archiveRetention: 90,
    userTimezone: "browser"
  });
  const tz = userTimezone || "browser";
  const timelineDays = new Map();
  const profiles = new Set();
  const failures = [];

  for (const session of prunedSessions) {
    try {
      if (session.kind === "timeline") {
        const key = `${session.profileKey}|${getLocalDayKey(session.timestamp, tz)}`;
        const grouped = timelineDays.get(key) || [];
        grouped.push(session);
        timelineDays.set(key, grouped);
      } else {
        await archiveSession(session);
        profiles.add(session.profileKey);
      }
    } catch (error) {
      console.warn("Failed to apply retention to session:", session.path, error);
      failures.push(`${session.path}: ${error.message}`);
    }
  }

  for (const [key, sessions] of timelineDays) {
    const [profileKey, dayKey] = key.split("|");
    try {
      await archiveTimelineDay(profileKey, dayKey, sessions);
      profiles.add(profileKey);
    } catch (error) {
      console.warn("Failed to archive timeline day:", dayKey, error);
      failures.push(`${dayKey}: ${error.message}`);
    }
  }

  for (const profileKey of profiles) {
    try {
      await pruneArchiveForProfile(profileKey, archiveRetention, tz);
    } catch (error) {
      failures.push(`${profileKey} archive retention: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Retention incomplete (${failures.length} failure(s)): ${failures[0]}`);
  }
}

async function deleteExpiredSavedSessions(expiredSessions) {
  const failures = [];
  for (const session of expiredSessions) {
    try {
      const file = await fetchGitHubJson(session.path);
      if (file.exists) {
        await deleteGitHubFile(
          session.path,
          file.sha,
          `Delete expired Saved snapshot: ${session.path}`
        );
      }
    } catch (error) {
      failures.push(`${session.path}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Saved retention incomplete (${failures.length} failure(s)): ${failures.join("; ")}`
    );
  }
}

async function disposeRetentionResult(retained) {
  const failures = [];
  try {
    await disposePrunedSessions(retained.pruned || []);
  } catch (error) {
    failures.push(error.message);
  }
  try {
    await deleteExpiredSavedSessions(retained.deleted || []);
  } catch (error) {
    failures.push(error.message);
  }
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
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

async function listTimelineSessionFiles(path, depth = 0) {
  const directory = await listGitHubDirectory(path);
  if (!directory.exists) return [];

  const files = [];
  for (const entry of directory.entries) {
    if (isLegacySessionFile(entry)) {
      files.push(entry);
    } else if (entry.type === "dir" && depth < 4) {
      files.push(...await listTimelineSessionFiles(entry.path, depth + 1));
    }
  }
  return files;
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
              summary.kind =
                !summary.isManualSnapshot &&
                !summary.pinned &&
                !summary.friendlyName
                  ? "timeline"
                  : "history";
              summaries.push(summary);
            }
          }
        }

        const timelineFiles = await listTimelineSessionFiles(
          `${clientRootPath}/history/timeline`
        );

        for (const timelineFile of timelineFiles) {
          const summary = await readSessionSummary(
            timelineFile.path,
            timelineFile.sha
          );

          if (summary) {
            summary.kind = "timeline";
            summaries.push(summary);
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

  return normalizeIndex({
    sessions: summaries
  });
}

async function replaceSessionIndexSafely(
  sessions,
  timelineRetention,
  savedRetention,
  message,
  scanStartedAt,
  timezone
) {
  let retained = applyRetention(
    sessions,
    timelineRetention,
    savedRetention,
    timezone
  );
  let finalIndex;

  await putGitHubJson(INDEX_PATH, null, message, undefined, {
    conflictResolver: async (currentData) => {
      const currentIndex = normalizeIndex(currentData || { sessions: [] });
      const indexChangedDuringScan =
        scanStartedAt &&
        currentIndex.updatedAt &&
        new Date(currentIndex.updatedAt) > new Date(scanStartedAt);
      const repositorySessions = indexChangedDuringScan
        ? (await buildIndexFromRepository()).sessions
        : sessions;
      retained = applyRetention(
        repositorySessions,
        timelineRetention,
        savedRetention,
        timezone
      );
      finalIndex = normalizeIndex({ sessions: retained.kept });
      finalIndex.updatedAt = new Date().toISOString();
      return finalIndex;
    }
  });

  return { ...retained, index: finalIndex };
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

  const scanStartedAt = new Date().toISOString();
  const rebuiltIndex = await buildIndexFromRepository();
  const { timelineRetention, savedRetention, userTimezone } = await chrome.storage.sync.get({
    timelineRetention: 10,
    savedRetention: 0,
    userTimezone: "browser"
  });
  const retained = await replaceSessionIndexSafely(
    rebuiltIndex.sessions,
    timelineRetention,
    savedRetention,
    "Rebuild session index",
    scanStartedAt,
    userTimezone || "browser"
  );
  await disposeRetentionResult(retained);

  return retained.index;
}

async function reconcileRepositoryRetention() {
  try {
    const scanStartedAt = new Date().toISOString();
    const rebuiltIndex = await buildIndexFromRepository();
    const { timelineRetention, savedRetention, userTimezone } = await chrome.storage.sync.get({
      timelineRetention: 10,
      savedRetention: 0,
      userTimezone: "browser"
    });
    const retained = await replaceSessionIndexSafely(
      rebuiltIndex.sessions,
      timelineRetention,
      savedRetention,
      "Reconcile session retention",
      scanStartedAt,
      userTimezone || "browser"
    );
    await disposeRetentionResult(retained);

    const rootDir = await listGitHubDirectory(SESSIONS_DIR);
    const { archiveRetention, userTimezone: reconcileTz } = await chrome.storage.sync.get({
      archiveRetention: 90,
      userTimezone: "browser"
    });
    for (const entry of rootDir.entries) {
      if (entry.type === "dir") {
        await pruneArchiveForProfile(entry.name, archiveRetention, reconcileTz || "browser");
      }
    }
    await chrome.storage.local.set({
      lastRetentionRun: new Date().toISOString()
    });
    return {
      success: true,
      archived: retained.pruned.length,
      deleted: retained.deleted.length
    };
  } catch (error) {
    console.error("Retention reconciliation failed:", error);
    return { success: false, error: error.message };
  }
}

async function runDailyRetentionIfDue() {
  const { lastRetentionRun } = await chrome.storage.local.get(
    "lastRetentionRun"
  );
  const { userTimezone } = await chrome.storage.sync.get({ userTimezone: "browser" });
  const tz = userTimezone || "browser";
  if (
    lastRetentionRun &&
    getLocalDayKey(lastRetentionRun, tz) === getLocalDayKey(new Date().toISOString(), tz)
  ) {
    return;
  }

  const result = await reconcileRepositoryRetention();
  if (!result.success) {
    console.warn("Daily retention did not complete:", result.error);
  }
}

/**
 * Atomic update to INDEX_PATH to prevent race conditions from overlapping syncs.
 * Fetches latest index, merges new entries, applies retention, and pushes back.
 */
async function updateIndexWithNewSessions(newSummaries) {
  const { timelineRetention, savedRetention, userTimezone } = await chrome.storage.sync.get({
    timelineRetention: 10,
    savedRetention: 0,
    userTimezone: "browser"
  });
  const tz = userTimezone || "browser";
  let retained = { kept: [], pruned: [], deleted: [] };
  await mutateSessionIndex((currentIndex) => {
    const newPaths = new Set(newSummaries.map((session) => session.path));
    const merged = [
      ...newSummaries,
      ...currentIndex.sessions.filter((session) => !newPaths.has(session.path))
    ];
    retained = applyRetention(merged, timelineRetention, savedRetention, tz);
    return { ...currentIndex, sessions: retained.kept };
  }, "Update session index (conflict-safe merge)");

  await disposeRetentionResult(retained);

  return retained;
}

async function removeSessionFromIndex(path) {
  return await mutateSessionIndex((index) => ({
    ...index,
    sessions: index.sessions.filter((session) => session.path !== path)
  }), "Remove session from active index");
}

async function updateSessionInIndex(path, updates) {
  return await mutateSessionIndex((index) => ({
    ...index,
    sessions: index.sessions.map((session) =>
      session.path === path ? { ...session, ...updates } : session
    )
  }), "Update session metadata in active index");
}

async function computeSessionSignature(
  sessionData
) {
  // Regex to strip common notification counts like (1), [5], etc.
  // This makes signatures more stable for sites that change titles frequently.
  const titleSanitizer = /\s*\([0-9+]+\)\s*|\s*\[[0-9+]+\].*/g;

  const normalized = sessionData.windows.map(
    (windowData) =>
      windowData.tabs.map((tab) => {
        const cleanTitle = (tab.title || "")
          .replace(titleSanitizer, "")
          .trim();
        return {
          title: cleanTitle,
          url: tab.url || ""
        };
      })
  );

  const encoded = new TextEncoder().encode(
    JSON.stringify({
      browserAlias:
        normalizeProfileName(sessionData.browserAlias),
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

function shouldSaveTab(tab, excludeLocalTabs) {
  const url = tab.url || tab.pendingUrl || "";

  if (url === "chrome://newtab/") {
    return false;
  }

  if (!excludeLocalTabs) {
    return true;
  }

  try {
    const parsed = new URL(url);
    return !(
      parsed.protocol === "file:" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]"
    );
  } catch {
    return true;
  }
}

function getLastTimelineSignature(index, profileKey, clientId) {
  return index.sessions
    .filter((session) =>
      session.profileKey === profileKey &&
      session.clientId === clientId &&
      session.kind === "timeline"
    )
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0]
    ?.signature || null;
}

function saveSessionToGitHub(options = {}) {
  return enqueueMutation(() => performSaveSessionToGitHub(options));
}

async function performSaveSessionToGitHub(
  options = {}
) {
  try {
    const clientId =
      await initializeClientId();
    const profileStorageKey =
      await getProfileStorageKey();
    const profileName = await getProfileDisplayName();
    const { excludeLocalTabs = false } =
      await chrome.storage.sync.get("excludeLocalTabs");
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

    // Retention must continue even when the tabs never change. Limit the full
    // repository reconciliation to once per local calendar day.
    if (options.runRetention) {
      await runDailyRetentionIfDue();
    }

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
      isManualSnapshot: forceSnapshot,
      windows: windows
        .map((windowData) => ({
          id: windowData.id,
          tabs: windowData.tabs
            .filter(
              (tab) => shouldSaveTab(tab, excludeLocalTabs)
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
    console.log(`Syncing session for profile: ${profileStorageKey} (isTimeline: ${isTimeline}, force: ${forceSnapshot})`);

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
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const historyPath = `${SESSIONS_DIR}/${profileStorageKey}/history/session-${Date.now()}-${uniqueSuffix}.json`;

    const latestSessionData = {
      ...sessionData,
      isTimeline: undefined,
      isManualSnapshot: undefined,
      friendlyName: null,
      pinned: false
    };

    let latestSummary = null;

    const currentIndex = await loadSessionIndex();
    // 1. Timeline Skip Detection:
    // Compare against the last timeline entry — not latest.json, which is updated by every regular sync.
    if (isTimeline && !forceSnapshot) {
      const lastTimelineSignature = getLastTimelineSignature(
        currentIndex,
        profileStorageKey,
        clientId
      );
      
      if (signature === lastTimelineSignature) {
        console.log("Timeline skip: Session content identical to last timeline snapshot.");
        await chrome.storage.sync.set({
          lastSyncTime: new Date().toISOString(),
          lastSyncStatus: "success"
        });
        return { success: true, skipped: true, message: "Timeline is already up to date." };
      } else {
        console.log(`Timeline change detected: current=${signature.slice(0, 8)} last=${lastTimelineSignature?.slice(0, 8) || "none"}`);
      }
    }

    if (
      !hasChanged &&
      !forceSnapshot &&
      !isTimeline
    ) {
       console.log("Sync skip: No changes since last backup and not a timeline pulse.");
       return { success: true, skipped: true, message: "No changes to backup." };
    }

    // 2. Global Baseline Update:
    // Update latest.json ONLY if there's a global change.
    if (hasChanged) {
      console.log(`Updating global baseline (latest.json)... hasChanged=${hasChanged}`);
      let committedLatestData = latestSessionData;
      const latestResponse = await putGitHubJson(
        latestPath,
        null,
        isTimeline ? `Update baseline (Timeline pulse) for ${alias}` : `Update latest session for ${alias}`,
        undefined,
        {
          conflictResolver: (currentData) => {
            committedLatestData =
              currentData?.timestamp &&
              new Date(currentData.timestamp) > new Date(latestSessionData.timestamp)
                ? currentData
                : latestSessionData;
            return committedLatestData;
          }
        }
      );

      latestSummary = buildSessionSummary(
        committedLatestData,
        latestPath,
        latestResponse.content.sha,
        "latest"
      );
    }

    // Timeline alarms and manual snapshots are separate actions. A manual snapshot
    // creates one history entry, never an additional timeline entry.
    const createTimelinePulse = isTimeline;

    // The Timeline owns automatic history. The Saved view contains only
    // explicit manual snapshots.
    const createHistorySnapshot = forceSnapshot;

    let historySummary = null;
    let timelineSummary = null;

    // A. Handle Timeline/Pulse creation
    if (createTimelinePulse) {
      const timelineDate = new Date(sessionData.timestamp);
      const timelinePartition = [
        timelineDate.getUTCFullYear(),
        String(timelineDate.getUTCMonth() + 1).padStart(2, "0"),
        String(timelineDate.getUTCDate()).padStart(2, "0")
      ].join("/");
      const timelinePath = `${SESSIONS_DIR}/${profileStorageKey}/history/timeline/${timelinePartition}/session-${Date.now()}-${uniqueSuffix}.json`;
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

    // B. Handle a manual history snapshot.
    let finalHistoryPath = historyPath;
    if (createHistorySnapshot) {
      const historyResponse = await putGitHubJson(
        historyPath,
        sessionData,
        `Create manual snapshot for ${alias}`
      );

      historySummary = buildSessionSummary(
        sessionData,
        historyPath,
        historyResponse.content.sha,
        "history"
      );
    }


    const newSummaries = [
      ...(latestSummary ? [latestSummary] : []),
      ...(historySummary ? [historySummary] : []),
      ...(timelineSummary ? [timelineSummary] : [])
    ];

    if (newSummaries.length > 0) {
      console.log(`Pushing ${newSummaries.length} new summary entries to index (Atomic Merge)...`);
      await updateIndexWithNewSessions(newSummaries);
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
      filePath: createHistorySnapshot
        ? finalHistoryPath
        : latestPath,
      latestPath,
      snapshotCreated:
        createTimelinePulse || createHistorySnapshot,
      snapshotReason: forceSnapshot
        ? "manual"
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
  const alarmName = "sessionSync";
  const existing = await chrome.alarms.get(alarmName);
  
  if (intervalMinutes > 0) {
    if (existing && existing.periodInMinutes === intervalMinutes) {
      console.log(`Sync alarm "${alarmName}" already exists with correct interval. Skipping recreation.`);
      return;
    }
    
    // Add jitter: small random initial delay between 0 and 1 minute
    const delayInMinutes = Math.random();

    await chrome.alarms.create(
      alarmName,
      {
        delayInMinutes,
        periodInMinutes: intervalMinutes
      }
    );
    console.log(
      `Sync alarm "${alarmName}" (re)created for ${intervalMinutes}m with ${Math.round(delayInMinutes * 60)}s jitter.`
    );
  } else {
    await chrome.alarms.clear(
      alarmName
    );
    console.log(`Sync alarm "${alarmName}" disabled`);
  }
}

/**
 * Setup periodic timeline using alarms
 */
async function setupTimelineAlarm(intervalMinutes) {
  const alarmName = "timelineSync";
  const existing = await chrome.alarms.get(alarmName);

  if (intervalMinutes > 0) {
    if (existing && existing.periodInMinutes === intervalMinutes) {
      console.log(`Timeline alarm "${alarmName}" already exists with correct interval. Skipping recreation.`);
      return;
    }

    // Add jitter: small random initial delay between 0.1 and 1.5 minutes
    const delayInMinutes = 0.1 + Math.random() * 1.4;

    await chrome.alarms.create(alarmName, {
      delayInMinutes,
      periodInMinutes: intervalMinutes
    });
    console.log(`Timeline alarm "${alarmName}" (re)created for ${intervalMinutes}m with ${Math.round(delayInMinutes * 60)}s jitter.`);
  } else {
    await chrome.alarms.clear(alarmName);
    console.log(`Timeline alarm "${alarmName}" disabled`);
  }
}

function isTransientError(result) {
  if (!result || result.success) return false;
  return /40[78]|409|422|429|5\d\d|\bsha\b|conflict|expected/i.test(
    result.error || ""
  );
}

/**
 * Alarm listener for periodic syncing
 */
chrome.alarms.onAlarm.addListener(
  async (alarm) => {
    const options =
      alarm.name === "timelineSync"
        ? { isTimeline: true, runRetention: true }
        : alarm.name === "sessionSync"
          ? { runRetention: true }
          : null;

    if (options === null) return;

    console.log(`Running scheduled ${alarm.name}...`);
    let result = await saveSessionToGitHub(options);

    for (let attempt = 1; attempt <= 3 && isTransientError(result); attempt++) {
      console.warn(`Transient error on ${alarm.name}, retry ${attempt}/3 in 10s...`);
      await sleep(10000);
      result = await saveSessionToGitHub(options);
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

  if (sessionSummary.kind === "timeline" || sessionFile.data.isTimeline) {
    throw new Error("Timeline snapshots expire or can be deleted; they cannot be archived");
  }

  const sessionDataToArchive = { ...sessionFile.data, pinned: false };

  // 2. Put into archive, updating an existing target when a prior retry got
  // that far. This makes archive moves idempotent.
  await putGitHubJson(
    archivePath,
    null,
    `Archive session snapshot ${filename} to ${year}/${month}`,
    undefined,
    {
      conflictResolver: (currentData) => ({
        ...(currentData || {}),
        ...sessionDataToArchive
      })
    }
  );

  const newSummary = {
    ...sessionSummary,
    path: archivePath,
    pinned: false,
    sha: undefined // SHA will be fresh in archive.
  };

  await mutateArchiveIndex(profileKey, (index) => ({
    ...index,
    sessions: [
      ...index.sessions.filter((session) => session.path !== archivePath),
      newSummary
    ]
  }), `Update archive index for ${year}/${month}`);

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
    if (sessionSummary.kind === "timeline") {
      return {
        success: false,
        error: "Timeline snapshots cannot be archived; delete them instead."
      };
    }

    // 1. Perform the archive move.
    await archiveSession(sessionSummary);

    // 2. Remove from the active index.
    await removeSessionFromIndex(sessionSummary.path);

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
    const isTimeline =
      sessionSummary.kind === "timeline" ||
      sessionSummary.path.includes("/timeline/");
    const historyPath = isTimeline
      ? `${SESSIONS_DIR}/${profileKey}/history/timeline/${filename}`
      : `${SESSIONS_DIR}/${profileKey}/history/${filename}`;

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
    await mutateArchiveIndex(profileKey, (index) => ({
      ...index,
      sessions: index.sessions.filter(
        (session) => session.path !== sessionSummary.path
      )
    }), "Update archive index after unarchiving");

    // 4. Delete the file from archive folder
    await deleteGitHubFile(
      sessionSummary.path,
      sessionFile.sha,
      `Delete unarchived session from archive: ${filename}`
    );

    // 5. Add to active index
    const newSummary = {
      ...sessionSummary,
      path: historyPath,
      pinned: false,
      sha: historyResponse.content.sha
    };
    
    await updateIndexWithNewSessions([newSummary]);

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
    const inferredProfileKey =
      sessionSummary.profileKey ||
      (sessionSummary.path.startsWith(`${SESSIONS_DIR}/`)
        ? sessionSummary.path.split("/")[1]
        : sessionSummary.path.split("/")[0]) ||
      (await getProfileStorageKey());
    const sessionPath = canonicalizeSessionPath(
      sessionSummary.path,
      inferredProfileKey
    );
    const fromArchive = isFromArchive || sessionPath.includes("/archive/");

    if (
      sessionSummary.kind === "latest" ||
      sessionPath.endsWith("/latest.json")
    ) {
      return {
        success: false,
        error: "Current sessions cannot be deleted; update them instead."
      };
    }

    // 1. Delete the file from GitHub.
    const file = await fetchGitHubJson(
      sessionPath
    );
    if (file.exists) {
      await deleteGitHubFile(
        sessionPath,
        file.sha,
        `Manual delete of session: ${sessionPath}`
      );
    }

    // 2. Remove from the appropriate index.
    if (fromArchive) {
      await mutateArchiveIndex(inferredProfileKey, (index) => ({
        ...index,
        sessions: index.sessions.filter(
          (session) => session.path !== sessionPath
        )
      }), "Update archive index after manual delete");
    } else {
      await removeSessionFromIndex(sessionPath);
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
    const archiveIndexFile = await fetchGitHubJson(archiveIndexPath);

    if (archiveIndexFile.exists) {
      const sessions = normalizeArchiveIndex(
        profileKey,
        archiveIndexFile.data
      ).sessions;
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

    const friendlyName = newName || null;

    await putGitHubJson(
      sessionPath,
      null,
      `Rename session to ${newName || "default"}`,
      undefined,
      {
        conflictResolver: (currentData) => ({
          ...(currentData || file.data),
          friendlyName
        })
      }
    );

    const isArchived = sessionPath.includes("/archive/");
    const profileKey = sessionPath.split("/")[1];

    if (isArchived) {
      await mutateArchiveIndex(profileKey, (index) => ({
        ...index,
        sessions: index.sessions.map((session) =>
          session.path === sessionPath
            ? { ...session, friendlyName }
            : session
        )
      }), "Rename archived session summary");
    } else {
      await updateSessionInIndex(sessionPath, {
        friendlyName
      });
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

    await putGitHubJson(
      sessionPath,
      null,
      `${isPinned ? "Pin" : "Unpin"} session`,
      undefined,
      {
        conflictResolver: (currentData) => ({
          ...(currentData || file.data),
          pinned: isPinned
        })
      }
    );

    const isArchived = sessionPath.includes("/archive/");
    const profileKey = sessionPath.split("/")[1];

    if (isArchived) {
      await mutateArchiveIndex(profileKey, (index) => ({
        ...index,
        sessions: index.sessions.map((session) =>
          session.path === sessionPath
            ? { ...session, pinned: isPinned }
            : session
        )
      }), "Toggle pin on archived session summary");
    } else {
      await updateSessionInIndex(sessionPath, {
        pinned: isPinned
      });
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
    const clientId = await initializeClientId();
    console.log("Service Worker initialized successfully with clientId:", clientId);

    // Re-sync alarms from storage to ensure they persist correctly
    const settings = await chrome.storage.sync.get(["syncInterval", "timelineInterval"]);
    
    if (settings.syncInterval !== undefined) {
      console.log(`Restoring sync alarm: ${settings.syncInterval}m`);
      await setupSyncAlarm(settings.syncInterval);
    }
    
    if (settings.timelineInterval !== undefined) {
      console.log(`Restoring timeline alarm: ${settings.timelineInterval}m`);
      await setupTimelineAlarm(settings.timelineInterval);
    }
  } catch (error) {
    console.error("Service Worker initialization failed:", error);
  }
})();

// Expose deterministic logic to the repository's Node test suite. `module` is
// undefined in the Chrome service worker, so this has no runtime effect there.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    applyRetention,
    buildSessionSummary,
    buildTimelineArchiveData,
    canonicalizeSessionPath,
    computeSessionSignature,
    deleteExpiredSavedSessions,
    getProfileDisplayName,
    getLastTimelineSignature,
    handleManualDelete,
    isWithinRetention,
    normalizeArchiveIndex,
    normalizeIndex,
    normalizeProfileName,
    performSaveSessionToGitHub,
    putGitHubJson
  };
}
