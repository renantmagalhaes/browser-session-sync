/**
 * Popup Script - Handles UI interactions and session management
 */

let allSessions = [];

function getDisplayHostname(url) {
  if (!url) {
    return "local";
  }

  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function getSessionTimestamp(session) {
  return (
    session.timestamp ||
    session.data?.timestamp ||
    null
  );
}

function getSessionAlias(session) {
  return (
    session.browserAlias ||
    session.data?.browserAlias ||
    "Unknown Browser"
  );
}

function getSessionWindowCount(session) {
  if (
    typeof session.windowCount ===
    "number"
  ) {
    return session.windowCount;
  }

  return (
    session.data?.windows?.length || 0
  );
}

function getSessionTabCount(session) {
  if (
    typeof session.tabCount === "number"
  ) {
    return session.tabCount;
  }

  return (
    session.data?.windows?.reduce(
      (sum, windowData) =>
        sum + windowData.tabs.length,
      0
    ) || 0
  );
}

function getPreviewTabs(session) {
  if (
    Array.isArray(session.previewTabs) &&
    session.previewTabs.length > 0
  ) {
    return session.previewTabs;
  }

  return (
    session.data?.windows
      ?.flatMap(
        (windowData) => windowData.tabs
      )
      .slice(0, 3) || []
  );
}

/**
 * Send message with retry logic for service worker delays
 */
async function sendMessageWithRetry(
  message,
  maxRetries = 5,
  delayMs = 200
) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= maxRetries;
    attempt++
  ) {
    try {
      console.log(
        `Attempt ${attempt}/${maxRetries} to send message:`,
        message.action
      );

      const response =
        await chrome.runtime.sendMessage(
          message
        );

      if (response) {
        console.log(
          "Got response:",
          response
        );
        return response;
      }

      console.warn(
        `Attempt ${attempt}: No response, retrying...`
      );

      if (attempt < maxRetries) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            delayMs * attempt
          )
        );
      }
    } catch (error) {
      lastError = error;
      console.warn(
        `Attempt ${attempt} error:`,
        error.message
      );

      if (attempt < maxRetries) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            delayMs * attempt
          )
        );
      }
    }
  }

  console.error(
    "All retries exhausted. Last error:",
    lastError
  );
  return null;
}

/**
 * Update status display
 */
async function updateStatus() {
  try {
    const response =
      await sendMessageWithRetry({
        action: "getStatus"
      });

    if (!response) {
      console.warn(
        "No response from background after retries"
      );

      const statusEl =
        document.getElementById(
          "statusMessage"
        );
      statusEl.textContent =
        "⏳ Initializing extension...";
      statusEl.className =
        "status-message";

      const lastSyncEl =
        document.getElementById(
          "lastSync"
        );
      lastSyncEl.textContent = "";

      return;
    }

    const statusEl =
      document.getElementById(
        "statusMessage"
      );
    const lastSyncEl =
      document.getElementById(
        "lastSync"
      );

    if (
      response.lastSyncStatus ===
      "success"
    ) {
      statusEl.textContent =
        "✅ Ready to sync";
      statusEl.className =
        "status-message success";
    } else if (
      response.lastSyncStatus
    ) {
      statusEl.textContent = `⚠️ ${response.lastSyncStatus}`;
      statusEl.className =
        "status-message error";
    } else {
      statusEl.textContent =
        "📡 No sync yet";
      statusEl.className =
        "status-message";
    }

    if (response.lastSyncTime) {
      const syncDate = new Date(
        response.lastSyncTime
      );
      lastSyncEl.textContent = `Last sync: ${syncDate.toLocaleString()}`;
    }
  } catch (error) {
    console.error(
      "Error updating status:",
      error
    );
  }
}

/**
 * Load and display all sessions
 */
async function loadSessions() {
  const sessionsList =
    document.getElementById(
      "sessionsList"
    );
  sessionsList.innerHTML =
    '<p class="loading">Loading sessions...</p>';

  try {
    const response =
      await sendMessageWithRetry({
        action: "listSessions"
      });

    if (!response) {
      throw new Error(
        "No response from background service worker"
      );
    }

    if (!response.success) {
      sessionsList.innerHTML = `<p class="error">Error loading sessions: ${response.error || "Unknown error"}</p>`;
      return;
    }

    allSessions =
      response.sessions || [];

    if (allSessions.length === 0) {
      sessionsList.innerHTML =
        '<p class="empty">No sessions saved yet. Click "Sync Now" to save your current session.</p>';
      return;
    }

    displaySessions(allSessions);
  } catch (error) {
    console.error(
      "Error loading sessions:",
      error
    );
    sessionsList.innerHTML = `<p class="error">Error: ${error.message}</p>`;
  }
}

/**
 * Display sessions with search filtering
 */
function displaySessions(
  sessionsToDisplay
) {
  const sessionsList =
    document.getElementById(
      "sessionsList"
    );
  sessionsList.innerHTML = "";

  if (sessionsToDisplay.length === 0) {
    sessionsList.innerHTML =
      '<p class="empty">No sessions match your search.</p>';
    return;
  }

  // Sort sessions by timestamp (newest first)
  const sorted = [
    ...sessionsToDisplay
  ].sort((a, b) => {
    return (
      new Date(getSessionTimestamp(b)) -
      new Date(getSessionTimestamp(a))
    );
  });

  for (const session of sorted) {
    const sessionEl =
      createSessionElement(session);
    sessionsList.appendChild(sessionEl);
  }
}

/**
 * Create a DOM element for a session
 */
function createSessionElement(session) {
  const div =
    document.createElement("div");
  div.className = "session-item";

  const date = new Date(
    getSessionTimestamp(session)
  );
  const tabCount =
    getSessionTabCount(session);
  const windowCount =
    getSessionWindowCount(session);

  const headerDiv =
    document.createElement("div");
  headerDiv.className =
    "session-header";

  const titleEl =
    document.createElement("div");
  titleEl.className = "session-title";
  titleEl.innerHTML = `
    <strong>${escapeHtml(getSessionAlias(session))}</strong>
    <span class="session-date">${date.toLocaleString()}</span>
  `;

  const statsEl =
    document.createElement("div");
  statsEl.className = "session-stats";
  statsEl.textContent = `${windowCount} window(s), ${tabCount} tab(s)`;

  headerDiv.appendChild(titleEl);
  headerDiv.appendChild(statsEl);

  // Tabs preview
  const tabsContainer =
    document.createElement("div");
  tabsContainer.className =
    "tabs-preview";

  const previewTabs =
    getPreviewTabs(session);

  for (const tab of previewTabs) {
    const tabEl =
      document.createElement("div");
    tabEl.className = "tab-preview";
    tabEl.title = tab.url;
    tabEl.innerHTML = `
      <span class="tab-title">${escapeHtml(tab.title || "Untitled")}</span>
      <span class="tab-url">${escapeHtml(getDisplayHostname(tab.url))}</span>
    `;
    tabsContainer.appendChild(tabEl);
  }

  if (tabCount > 3) {
    const moreEl =
      document.createElement("div");
    moreEl.className =
      "tab-preview more";
    moreEl.textContent = `+${tabCount - 3} more`;
    tabsContainer.appendChild(moreEl);
  }

  // Action buttons
  const actionsDiv =
    document.createElement("div");
  actionsDiv.className =
    "session-actions";

  const restoreBtn =
    document.createElement("button");
  restoreBtn.className =
    "btn btn-restore";
  restoreBtn.textContent = "📂 Restore";
  restoreBtn.onclick = () =>
    restoreSession(session.path);

  actionsDiv.appendChild(restoreBtn);

  div.appendChild(headerDiv);
  div.appendChild(tabsContainer);
  div.appendChild(actionsDiv);

  return div;
}

/**
 * Restore a session
 */
async function restoreSession(
  sessionPath
) {
  try {
    const response =
      await sendMessageWithRetry({
        action: "restoreSession",
        sessionPath: sessionPath
      });

    if (!response) {
      throw new Error(
        "No response from background service worker"
      );
    }

    if (response.success) {
      alert(
        `✅ Restored session: ${response.sessionRestored}`
      );
    } else {
      alert(
        `❌ Error restoring session: ${response.error}`
      );
    }
  } catch (error) {
    console.error(
      "Error restoring session:",
      error
    );
    alert(`Error: ${error.message}`);
  }
}

/**
 * Sync current session
 */
async function syncNow() {
  const btn =
    document.getElementById("syncNow");
  btn.disabled = true;
  btn.textContent = "⏳ Syncing...";

  try {
    const response =
      await sendMessageWithRetry({
        action: "saveSession"
      });

    if (!response) {
      throw new Error(
        "No response from background service worker"
      );
    }

    if (response.success) {
      await updateStatus();
      if (!response.skipped) {
        await loadSessions();
      }
      btn.textContent = response.skipped
        ? "🟰 No Changes"
        : "✅ Synced!";
      setTimeout(() => {
        if (btn.disabled) {
          btn.disabled = false;
          btn.textContent =
            "💾 Sync Now";
        }
      }, 2000);
    } else {
      alert(`Error: ${response.error}`);
      btn.disabled = false;
      btn.textContent = "💾 Sync Now";
    }
  } catch (error) {
    console.error(
      "Error syncing:",
      error
    );
    alert(`Error: ${error.message}`);
    btn.disabled = false;
    btn.textContent = "💾 Sync Now";
  }
}

/**
 * Search/filter sessions
 */
function filterSessions(searchTerm) {
  if (!searchTerm.trim()) {
    displaySessions(allSessions);
    return;
  }

  const term = searchTerm.toLowerCase();
  const filtered = allSessions.filter(
    (session) => {
      if (
        session.searchText &&
        session.searchText.includes(term)
      ) {
        return true;
      }

      const alias =
        getSessionAlias(session).toLowerCase();

      if (alias.includes(term)) {
        return true;
      }

      const previewTabs =
        getPreviewTabs(session);

      return previewTabs.some(
        (tab) =>
          (tab.title &&
            tab.title
              .toLowerCase()
              .includes(term)) ||
          (tab.url &&
            tab.url
              .toLowerCase()
              .includes(term))
      );
    }
  );

  displaySessions(filtered);
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div =
    document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Open settings page
 */
function openSettings() {
  chrome.runtime.openOptionsPage();
}

// Event listeners
document
  .getElementById("syncNow")
  .addEventListener("click", syncNow);
document
  .getElementById("refreshList")
  .addEventListener(
    "click",
    loadSessions
  );
document
  .getElementById("openSettings")
  .addEventListener(
    "click",
    openSettings
  );
document
  .getElementById("searchInput")
  .addEventListener("input", (e) => {
    filterSessions(e.target.value);
  });

// Initialize on popup open
updateStatus();
loadSessions();
