/**
 * Background Service Worker for Browser Session Sync
 * Handles:
 * - Client ID initialization
 * - GitHub API calls
 * - Periodic syncing with alarms
 * - Session saving and restoring
 */

const SESSIONS_DIR = "sessions";

console.log(
  "Service Worker: Initializing..."
);

async function handleMessage(request) {
  switch (request.action) {
    case "saveSession":
      console.log(
        "Processing saveSession"
      );
      return await saveSessionToGitHub();

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

/**
 * Save current browser session to GitHub
 */
async function saveSessionToGitHub() {
  try {
    const clientId =
      await initializeClientId();
    const { profileName } =
      await chrome.storage.sync.get(
        "profileName"
      );
    const alias =
      profileName || "Default Browser";

    // Collect all windows and tabs
    const windows =
      await chrome.windows.getAll({
        populate: true
      });
    const sessionData = {
      timestamp:
        new Date().toISOString(),
      browserAlias: alias,
      clientId: clientId,
      windows: windows.map((w) => ({
        id: w.id,
        tabs: w.tabs.map((t) => ({
          title: t.title,
          url: t.url,
          active: t.active
        }))
      }))
    };

    // Create file path: sessions/{clientId}/session-{timestamp}.json
    const timestamp = Date.now();
    const filePath = `${SESSIONS_DIR}/${clientId}/session-${timestamp}.json`;
    const content = JSON.stringify(
      sessionData,
      null,
      2
    );

    // Encode content to Base64 (UTF-8)
    const encoded = btoa(
      unescape(
        encodeURIComponent(content)
      )
    );

    const repoUrl = await getRepoUrl();
    const headers =
      await getGitHubHeaders();

    // Upload to GitHub
    const response = await fetch(
      `${repoUrl}/contents/${filePath}`,
      {
        method: "PUT",
        headers: headers,
        body: JSON.stringify({
          message: `Save session from ${alias} at ${new Date().toISOString()}`,
          content: encoded
        })
      }
    );

    if (!response.ok) {
      const error =
        await response.json();
      throw new Error(
        `GitHub API error: ${error.message}`
      );
    }

    // Store last sync timestamp
    await chrome.storage.sync.set({
      lastSyncTime:
        new Date().toISOString(),
      lastSyncStatus: "success"
    });

    console.log(
      "Session saved successfully:",
      filePath
    );
    return { success: true, filePath };
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

/**
 * List all sessions from GitHub
 */
async function listAllSessions() {
  try {
    const repoUrl = await getRepoUrl();
    const headers =
      await getGitHubHeaders();

    // First, check if sessions directory exists
    const dirResponse = await fetch(
      `${repoUrl}/contents/${SESSIONS_DIR}`,
      {
        headers: headers
      }
    );

    if (dirResponse.status === 404) {
      return {
        success: true,
        sessions: []
      };
    }

    if (!dirResponse.ok) {
      const error =
        await dirResponse.json();
      return {
        success: false,
        sessions: [],
        error:
          error.message ||
          `Failed to list ${SESSIONS_DIR}`
      };
    }

    const clientDirs =
      await dirResponse.json();
    const allSessions = [];

    // Iterate through each client folder
    for (const clientDir of clientDirs) {
      if (clientDir.type === "dir") {
        const filesResponse =
          await fetch(clientDir.url, {
            headers: headers
          });

        if (filesResponse.ok) {
          const files =
            await filesResponse.json();
          for (const file of files) {
            if (
              file.name.startsWith(
                "session-"
              ) &&
              file.name.endsWith(
                ".json"
              )
            ) {
              // Fetch and decode the file content
              const contentResponse =
                await fetch(file.url, {
                  headers: headers
                });

              if (contentResponse.ok) {
                const fileData =
                  await contentResponse.json();
                const decoded =
                  decodeURIComponent(
                    escape(
                      atob(
                        fileData.content
                      )
                    )
                  );
                const sessionData =
                  JSON.parse(decoded);
                allSessions.push({
                  path: file.path,
                  data: sessionData,
                  sha: fileData.sha
                });
              }
            }
          }
        }
      }
    }

    return {
      success: true,
      sessions: allSessions
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
    const repoUrl = await getRepoUrl();
    const headers =
      await getGitHubHeaders();

    // Fetch the session file
    const response = await fetch(
      `${repoUrl}/contents/${sessionPath}`,
      {
        headers: headers
      }
    );

    if (!response.ok) {
      throw new Error(
        "Failed to fetch session file"
      );
    }

    const fileData =
      await response.json();
    const decoded = decodeURIComponent(
      escape(atob(fileData.content))
    );
    const sessionData =
      JSON.parse(decoded);

    // Restore windows and tabs
    for (const windowData of sessionData.windows) {
      const urls = windowData.tabs
        .map((t) => t.url)
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
      // Initialize client ID on first install
      await initializeClientId();
      // Open options page
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
