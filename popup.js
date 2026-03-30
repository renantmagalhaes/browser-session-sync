/**
 * Popup Script - Handles UI interactions and session management
 */

let allSessions = [];
let selectedProfileKey = "__all__";
let currentProfileKey = null;
let currentTheme = "dark";
const sessionDetailsCache = new Map();

function applyTheme(theme) {
  currentTheme = theme === "light"
    ? "light"
    : "dark";
  document.documentElement.setAttribute(
    "data-theme",
    currentTheme
  );
  const toggle =
    document.getElementById(
      "themeToggle"
    );

  if (toggle) {
    toggle.textContent =
      currentTheme === "dark"
        ? "☀️"
        : "🌙";
    toggle.title =
      currentTheme === "dark"
        ? "Switch to light theme"
        : "Switch to dark theme";
  }
}

async function loadThemePreference() {
  const { themePreference } =
    await chrome.storage.sync.get(
      "themePreference"
    );
  applyTheme(
    themePreference || "dark"
  );
}

async function toggleTheme() {
  const nextTheme =
    currentTheme === "dark"
      ? "light"
      : "dark";
  applyTheme(nextTheme);
  await chrome.storage.sync.set({
    themePreference: nextTheme
  });
}

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

function getAllTabsFromSessionData(data) {
  return (
    data?.windows?.flatMap(
      (windowData) => windowData.tabs || []
    ) || []
  );
}

function getSessionProfileKey(session) {
  return (
    session.profileKey ||
    session.data?.profileKey ||
    session.clientId ||
    session.data?.clientId ||
    "unknown-profile"
  );
}

function getSessionKind(session) {
  return session.kind || "history";
}

async function getCurrentProfileKey() {
  const syncSettings =
    await chrome.storage.sync.get([
      "profileKey",
      "profileName"
    ]);
  const localSettings =
    await chrome.storage.local.get([
      "clientId"
    ]);

  return (
    syncSettings.profileKey ||
    (syncSettings.profileName || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") ||
    localSettings.clientId ||
    "__all__"
  );
}

function populateProfileFilter() {
  const filterEl =
    document.getElementById(
      "profileFilter"
    );
  const profileMap = new Map();

  for (const session of allSessions) {
    const key =
      getSessionProfileKey(session);

    if (!profileMap.has(key)) {
      profileMap.set(
        key,
        getSessionAlias(session)
      );
    }
  }

  const sortedProfiles = Array.from(
    profileMap.entries()
  ).sort((a, b) =>
    a[1].localeCompare(b[1])
  );

  filterEl.innerHTML = "";

  const allOption =
    document.createElement("option");
  allOption.value = "__all__";
  allOption.textContent =
    "All Profiles";
  filterEl.appendChild(allOption);

  for (const [key, label] of sortedProfiles) {
    const option =
      document.createElement("option");
    option.value = key;
    option.textContent = `${label} (${key})`;
    filterEl.appendChild(option);
  }

  if (
    currentProfileKey &&
    profileMap.has(currentProfileKey)
  ) {
    selectedProfileKey =
      currentProfileKey;
  } else if (
    selectedProfileKey !== "__all__" &&
    profileMap.has(selectedProfileKey)
  ) {
    // Keep the current selection.
  } else {
    selectedProfileKey = "__all__";
  }

  filterEl.value = selectedProfileKey;
}

function getFilteredSessions() {
  const searchTerm = document
    .getElementById("searchInput")
    .value.trim()
    .toLowerCase();

  return allSessions.filter((session) => {
    const inProfileScope =
      selectedProfileKey === "__all__" ||
      getSessionProfileKey(session) ===
        selectedProfileKey;

    if (!inProfileScope) {
      return false;
    }

    if (!searchTerm) {
      return true;
    }

    if (
      session.searchText &&
      session.searchText.includes(searchTerm)
    ) {
      return true;
    }

    const alias =
      getSessionAlias(session).toLowerCase();

    if (alias.includes(searchTerm)) {
      return true;
    }

    return getPreviewTabs(session).some(
      (tab) =>
        (tab.title &&
          tab.title
            .toLowerCase()
            .includes(searchTerm)) ||
        (tab.url &&
          tab.url
            .toLowerCase()
            .includes(searchTerm))
    );
  });
}

function applyFilters() {
  displaySessions(getFilteredSessions());
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
    populateProfileFilter();

    if (allSessions.length === 0) {
      sessionsList.innerHTML =
        '<p class="empty">No sessions saved yet. Click "Update Current" to sync your latest state or "Save Snapshot" to create history.</p>';
      return;
    }

    applyFilters();
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
  const kind =
    getSessionKind(session);
  const kindLabel =
    kind === "latest"
      ? "Current"
      : "Snapshot";
  titleEl.innerHTML = `
    <strong>${escapeHtml(getSessionAlias(session))}</strong>
    <span class="session-kind ${kind === "latest" ? "current" : "snapshot"}">${escapeHtml(kindLabel)}</span>
    <span class="session-date">${date.toLocaleString()}</span>
  `;

  const statsEl =
    document.createElement("div");
  statsEl.className = "session-stats";
  statsEl.textContent = `${windowCount} window(s), ${tabCount} tab(s)`;

  const actionsContainer =
    document.createElement("div");
  actionsContainer.className =
    "btn-restore-inline";

  const restoreBtn =
    document.createElement("button");
  restoreBtn.className =
    "btn btn-restore";
  restoreBtn.textContent = "Restore";
  restoreBtn.onclick = (e) => {
    e.stopPropagation();
    restoreSession(session.path);
  };

  actionsContainer.appendChild(restoreBtn);

  headerDiv.appendChild(titleEl);
  headerDiv.appendChild(statsEl);
  headerDiv.appendChild(actionsContainer);

  const detailsEl =
    document.createElement("details");
  detailsEl.className =
    "session-details";

  const summaryEl =
    document.createElement("summary");
  summaryEl.className =
    "session-summary";
  summaryEl.textContent =
    "Session details";

  const manualActions = document.createElement("div");
  manualActions.className = "manual-actions-details";

  // Only show Archive/Delete for snapshots in the active view (not in the archive view itself)
  const isArchiveView =
    document.getElementById(
      "archiveSessionsSection"
    ).style.display === "flex";

  if (!isArchiveView && kind !== "latest") {
    const archiveBtn =
      document.createElement("button");
    archiveBtn.className = "btn-archive-item";
    archiveBtn.textContent = "Archive";
    archiveBtn.onclick = (e) => {
      e.preventDefault();
      archiveSessionManually(session);
    };

    const deleteBtn =
      document.createElement("button");
    deleteBtn.className = "btn-delete-item";
    deleteBtn.textContent = "Delete";
    deleteBtn.onclick = (e) => {
      e.preventDefault();
      deleteSessionManually(session);
    };

    manualActions.appendChild(archiveBtn);
    manualActions.appendChild(deleteBtn);
  } else if (isArchiveView) {
    const deleteBtn =
      document.createElement("button");
    deleteBtn.className = "btn-delete-item";
    deleteBtn.textContent = "Delete snapshot";
    deleteBtn.onclick = (e) => {
      e.preventDefault();
      deleteSessionManually(session, true);
    };
    manualActions.appendChild(deleteBtn);
  }

  const tabsContainer =
    document.createElement("div");
  tabsContainer.className =
    "tabs-preview";

  // Create a container for the matching tabs preview
  const matchingTabsContainer =
    document.createElement("div");
  matchingTabsContainer.className =
    "matching-tabs-preview";
  tabsContainer.appendChild(matchingTabsContainer);

  const searchTerm = (document.getElementById("searchInput")?.value || "").trim().toLowerCase();

  if (searchTerm) {
    detailsEl.open = true;
  }

  const extraSection =
    document.createElement("div");
  extraSection.className =
    "tabs-more-section";

  const moreBtn =
    document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className =
    "tabs-more-toggle";
  moreBtn.textContent = `Show ${tabCount} tab${tabCount === 1 ? "" : "s"}`;

  const extraTabsContainer =
    document.createElement("div");
  extraTabsContainer.className =
    "extra-tabs";
  extraTabsContainer.hidden = true;

  // Helper function to build a single tab element
  function createTabElement(tab, searchQ = "") {
    const tabEl = document.createElement("div");
    tabEl.className = "tab-preview extra";
    tabEl.title = tab.url;
    
    const titleSpan = document.createElement("span");
    titleSpan.className = "tab-title";
    
    const urlSpan = document.createElement("span");
    urlSpan.className = "tab-url";
    
    // Highlight logic
    const titleText = tab.title || "Untitled";
    const urlText = getDisplayHostname(tab.url);
    
    if (searchQ) {
      const regex = new RegExp(`(${searchQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, "gi");
      titleSpan.innerHTML = escapeHtml(titleText).replace(regex, "<mark>$1</mark>");
      urlSpan.innerHTML = escapeHtml(urlText).replace(regex, "<mark>$1</mark>");
    } else {
      titleSpan.textContent = titleText;
      urlSpan.textContent = urlText;
    }

    const openBtn = document.createElement("button");
    openBtn.className = "btn-open-tab";
    openBtn.textContent = "Open";
    openBtn.onclick = (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: tab.url, active: false });
    };

    tabEl.appendChild(titleSpan);
    tabEl.appendChild(urlSpan);
    tabEl.appendChild(openBtn);
    return tabEl;
  }

  // If there's a search term, load the session gracefully to show exact matches immediately inside the details.
  if (searchTerm && tabCount > 0) {
    matchingTabsContainer.innerHTML = '<div class="loading-matches">🔍 Finding matches...</div>';
    
    (async () => {
      try {
        let fullSession = sessionDetailsCache.get(session.path);
        if (!fullSession) {
          const response = await sendMessageWithRetry({
            action: "getSessionDetails",
            sessionPath: session.path
          });
          if (response && response.success) {
            fullSession = response.session;
            sessionDetailsCache.set(session.path, fullSession);
          }
        }

        matchingTabsContainer.innerHTML = "";
        
        if (fullSession) {
          const allTabs = getAllTabsFromSessionData(fullSession);
          const matchedTabs = allTabs.filter(tab => {
            return (tab.title && tab.title.toLowerCase().includes(searchTerm)) ||
                   (tab.url && tab.url.toLowerCase().includes(searchTerm));
          });

          if (matchedTabs.length > 0) {
            const matchesHeader = document.createElement("div");
            matchesHeader.className = "matches-header";
            matchesHeader.textContent = `${matchedTabs.length} matching tab${matchedTabs.length === 1 ? "" : "s"}:`;
            matchingTabsContainer.appendChild(matchesHeader);

            for (const tab of matchedTabs) {
              matchingTabsContainer.appendChild(createTabElement(tab, searchTerm));
            }
          }
        }
      } catch (err) {
        matchingTabsContainer.innerHTML = "";
      }
    })();
  }

  if (tabCount > 0) {
    const extraSection =
      document.createElement("div");
    extraSection.className =
      "tabs-more-section";

    const moreBtn =
      document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className =
      "tabs-more-toggle";
    moreBtn.textContent = `Show ${tabCount} tab${tabCount === 1 ? "" : "s"}`;

    const extraTabsContainer =
      document.createElement("div");
    extraTabsContainer.className =
      "extra-tabs";
    extraTabsContainer.hidden = true;

    moreBtn.onclick = async () => {
      const isOpen =
        !extraTabsContainer.hidden;

      if (isOpen) {
        extraTabsContainer.hidden = true;
        moreBtn.textContent = `Show ${tabCount} tab${tabCount === 1 ? "" : "s"}`;
        return;
      }

      if (
        !extraTabsContainer.dataset.loaded
      ) {
        moreBtn.disabled = true;
        moreBtn.textContent =
          "Loading tabs...";

        try {
          let fullSession =
            sessionDetailsCache.get(
              session.path
            );

          if (!fullSession) {
            const response =
              await sendMessageWithRetry({
                action:
                  "getSessionDetails",
                sessionPath:
                  session.path
              });

            if (
              !response ||
              !response.success
            ) {
              throw new Error(
                response?.error ||
                  "Failed to load session details"
              );
            }

            fullSession =
              response.session;
            sessionDetailsCache.set(
              session.path,
              fullSession
            );
          }

          const allTabs =
            getAllTabsFromSessionData(
              fullSession
            );

          if (allTabs.length === 0) {
            const emptyState =
              document.createElement(
                "div"
              );
            emptyState.className =
              "extra-tabs-empty";
            emptyState.textContent =
              "No additional tabs to show.";
            extraTabsContainer.appendChild(
              emptyState
            );
          } else {
            for (const tab of allTabs) {
              extraTabsContainer.appendChild(createTabElement(tab, searchTerm));
            }
          }

          extraTabsContainer.dataset.loaded =
            "true";
        } catch (error) {
          const errorEl =
            document.createElement("div");
          errorEl.className =
            "extra-tabs-error";
          errorEl.textContent =
            error.message ||
            "Unable to load additional tabs.";
          extraTabsContainer.replaceChildren(
            errorEl
          );
          extraTabsContainer.dataset.loaded =
            "true";
        } finally {
          moreBtn.disabled = false;
        }
      }

      extraTabsContainer.hidden = false;
      moreBtn.textContent =
        "Hide tabs";
    };

    extraSection.appendChild(moreBtn);
    extraSection.appendChild(
      extraTabsContainer
    );
    tabsContainer.appendChild(extraSection);
  }

  detailsEl.appendChild(summaryEl);
  if (manualActions.hasChildNodes()) {
    detailsEl.appendChild(manualActions);
  }
  detailsEl.appendChild(tabsContainer);

  div.appendChild(headerDiv);
  div.appendChild(detailsEl);

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
  btn.textContent =
    "⏳ Updating...";

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
        : "✅ Updated";
      setTimeout(() => {
        if (btn.disabled) {
          btn.disabled = false;
          btn.textContent =
            "🔄 Update Current";
        }
      }, 2000);
    } else {
      alert(`Error: ${response.error}`);
      btn.disabled = false;
      btn.textContent =
        "🔄 Update Current";
    }
  } catch (error) {
    console.error(
      "Error syncing:",
      error
    );
    alert(`Error: ${error.message}`);
    btn.disabled = false;
    btn.textContent =
      "🔄 Update Current";
  }
}

async function saveSnapshot() {
  const btn =
    document.getElementById(
      "saveSnapshot"
    );
  btn.disabled = true;
  btn.textContent =
    "⏳ Saving...";

  try {
    const response =
      await sendMessageWithRetry({
        action: "saveSnapshot"
      });

    if (!response) {
      throw new Error(
        "No response from background service worker"
      );
    }

    if (response.success) {
      await updateStatus();
      await loadSessions();
      btn.textContent =
        response.snapshotCreated
          ? "✅ Saved"
          : "🟰 Unchanged";
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent =
          "📸 Save Snapshot";
      }, 2000);
    } else {
      alert(`Error: ${response.error}`);
      btn.disabled = false;
      btn.textContent =
        "📸 Save Snapshot";
    }
  } catch (error) {
    console.error(
      "Error saving snapshot:",
      error
    );
    alert(`Error: ${error.message}`);
    btn.disabled = false;
    btn.textContent =
      "📸 Save Snapshot";
  }
}

async function archiveSessionManually(
  session
) {
  if (
    !confirm(
      "Move this session to the permanent archive?"
    )
  ) {
    return;
  }

  try {
    const response = await sendMessageWithRetry({
      action: "archiveSessionManually",
      sessionSummary: session
    });

    if (response && response.success) {
      alert("✅ Session moved to archive.");
      await loadSessions();
    } else {
      alert(
        `❌ Error: ${response?.error || "Unknown error"}`
      );
    }
  } catch (err) {
    alert(`❌ Error: ${err.message}`);
  }
}

async function deleteSessionManually(
  session,
  isFromArchive = false
) {
  if (
    !confirm(
      "Are you sure you want to PERMANENTLY delete this session? This cannot be undone."
    )
  ) {
    return;
  }

  try {
    const response = await sendMessageWithRetry({
      action: "deleteSession",
      sessionSummary: session,
      isFromArchive: isFromArchive
    });

    if (response && response.success) {
      alert("✅ Session deleted.");
      if (isFromArchive) {
        const query = document.getElementById(
          "archiveSearchInput"
        ).value;
        await loadArchive(query);
      } else {
        await loadSessions();
      }
    } else {
      alert(
        `❌ Error: ${response?.error || "Unknown error"}`
      );
    }
  } catch (err) {
    alert(`❌ Error: ${err.message}`);
  }
}

/**
 * Archive Search and View
 */
function switchView(view) {
  const activeSection = document.getElementById(
    "activeSessionsSection"
  );
  const archiveSection = document.getElementById(
    "archiveSessionsSection"
  );
  const searchSection = document.querySelector(
    ".search-section"
  );

  if (view === "archive") {
    activeSection.style.display = "none";
    searchSection.style.display = "none";
    archiveSection.style.display = "flex";
    loadArchive("");
  } else {
    activeSection.style.display = "flex";
    searchSection.style.display = "block";
    archiveSection.style.display = "none";
    loadSessions();
  }
}

async function loadArchive(query = "") {
  const archiveList =
    document.getElementById("archiveList");
  archiveList.innerHTML =
    '<p class="loading">Searching archive...</p>';

  try {
    const response = await sendMessageWithRetry({
      action: "searchArchive",
      query: query,
      profileKey:
        selectedProfileKey === "__all__"
          ? null
          : selectedProfileKey
    });

    if (!response || !response.success) {
      throw new Error(
        response?.error ||
          "Failed to load archive"
      );
    }

    displayArchiveSessions(response.sessions);
  } catch (error) {
    console.error(
      "Error loading archive:",
      error
    );
    archiveList.innerHTML = `<p class="error">Error: ${error.message}</p>`;
  }
}

function displayArchiveSessions(sessions) {
  const archiveList =
    document.getElementById("archiveList");
  archiveList.innerHTML = "";

  if (sessions.length === 0) {
    archiveList.innerHTML =
      '<p class="empty">No archived sessions found.</p>';
    return;
  }

  for (const session of sessions) {
    const sessionEl =
      createSessionElement(session);
    archiveList.appendChild(sessionEl);
  }
}

/**
 * Search/filter sessions
 */
function filterSessions(searchTerm) {
  void searchTerm;
  applyFilters();
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
  .getElementById("saveSnapshot")
  .addEventListener(
    "click",
    saveSnapshot
  );
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
document
  .getElementById("profileFilter")
  .addEventListener(
    "change",
    (e) => {
      selectedProfileKey =
        e.target.value;
      applyFilters();
    }
  );
document
  .getElementById("themeToggle")
  .addEventListener(
    "click",
    toggleTheme
  );
document
  .getElementById("viewArchive")
  .addEventListener("click", () =>
    switchView("archive")
  );
document
  .getElementById("backToActive")
  .addEventListener("click", () =>
    switchView("active")
  );
document
  .getElementById("archiveSearchInput")
  .addEventListener("input", (e) => {
    loadArchive(e.target.value);
  });

// Initialize on popup open
(async () => {
  await loadThemePreference();
  currentProfileKey =
    await getCurrentProfileKey();
  selectedProfileKey =
    currentProfileKey || "__all__";
  updateStatus();
  loadSessions();
})();
