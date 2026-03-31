/**
 * Options Script - Handles settings management
 */

const FORM_ID = "settingsForm";
const MESSAGE_ID = "message";

async function applyStoredTheme() {
  const { themePreference } =
    await chrome.storage.sync.get(
      "themePreference"
    );
  document.documentElement.setAttribute(
    "data-theme",
    themePreference || "dark"
  );
}

function slugifyProfileKey(value) {
  return (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Load saved settings into form
 */
async function loadSettings() {
  const settings =
    await chrome.storage.sync.get([
      "githubUsername",
      "githubRepo",
      "githubToken",
      "profileName",
      "profileKey",
      "syncInterval",
      "timelineInterval",
      "timelineRetention",
      "excludeLocalTabs",
      "lastSyncTime"
    ]);

  const local =
    await chrome.storage.local.get(
      "clientId"
    );

  // Populate form fields
  if (settings.githubUsername) {
    document.getElementById(
      "githubUsername"
    ).value = settings.githubUsername;
  }
  if (settings.githubRepo) {
    document.getElementById(
      "githubRepo"
    ).value = settings.githubRepo;
  }
  if (settings.githubToken) {
    document.getElementById(
      "githubToken"
    ).value = settings.githubToken;
  }
  if (settings.profileName) {
    document.getElementById(
      "profileName"
    ).value = settings.profileName;
  }
  const derivedProfileKey =
    settings.profileKey ||
    slugifyProfileKey(
      settings.profileName
    ) ||
    local.clientId ||
    "";
  if (derivedProfileKey) {
    document.getElementById(
      "profileKey"
    ).value = derivedProfileKey;
  }
  if (
    settings.syncInterval !== undefined
  ) {
    document.getElementById(
      "syncInterval"
    ).value = settings.syncInterval;
  }
  if (
    settings.timelineInterval !== undefined
  ) {
    document.getElementById(
      "timelineInterval"
    ).value = settings.timelineInterval;
  }
  if (
    settings.timelineRetention !== undefined
  ) {
    document.getElementById(
      "timelineRetention"
    ).value = settings.timelineRetention;
  }
  if (settings.excludeLocalTabs) {
    document.getElementById(
      "excludeLocalTabs"
    ).checked =
      settings.excludeLocalTabs;
  }
  if (local.clientId) {
    document.getElementById(
      "clientId"
    ).value = local.clientId;
  }
  if (derivedProfileKey) {
    document.getElementById(
      "profileKeyDisplay"
    ).textContent =
      `Profile folder: ${derivedProfileKey}`;
  }

  // Display last sync time
  if (settings.lastSyncTime) {
    const syncDate = new Date(
      settings.lastSyncTime
    );
    document.getElementById(
      "lastSyncDisplay"
    ).textContent =
      `Last sync: ${syncDate.toLocaleString()}`;
  } else {
    document.getElementById(
      "lastSyncDisplay"
    ).textContent = "No syncs yet";
  }

  if (local.clientId) {
    document.getElementById(
      "clientIdDisplay"
    ).textContent =
      `Client ID: ${local.clientId}`;
  }
}

/**
 * Save settings from form
 */
async function saveSettings() {
  const form =
    document.getElementById(FORM_ID);

  // Validate required fields
  if (!form.checkValidity()) {
    showMessage(
      "Please fill in all required fields",
      "error"
    );
    return false;
  }

  const settings = {
    githubUsername: document
      .getElementById("githubUsername")
      .value.trim(),
    githubRepo: document
      .getElementById("githubRepo")
      .value.trim(),
    githubToken: document
      .getElementById("githubToken")
      .value.trim(),
    profileName: document
      .getElementById("profileName")
      .value.trim(),
    profileKey: slugifyProfileKey(
      document.getElementById(
        "profileKey"
      ).value.trim() ||
        document.getElementById(
          "profileName"
        ).value.trim()
    ),
    syncInterval: parseInt(
      document.getElementById(
        "syncInterval"
      ).value,
      10
    ),
    timelineInterval: parseInt(
      document.getElementById(
        "timelineInterval"
      ).value,
      10
    ),
    timelineRetention: parseInt(
      document.getElementById(
        "timelineRetention"
      ).value,
      10
    ),
    excludeLocalTabs:
      document.getElementById(
        "excludeLocalTabs"
      ).checked
  };

  if (!settings.profileKey) {
    showMessage(
      "Please enter a profile name or profile folder",
      "error"
    );
    return false;
  }

  try {
    // Save to sync storage
    await chrome.storage.sync.set(
      settings
    );

    // Setup alarm if interval is set
    if (settings.syncInterval > 0) {
      await chrome.runtime.sendMessage({
        action: "setupSync",
        intervalMinutes:
          settings.syncInterval
      });
    } else {
      await chrome.runtime.sendMessage({
        action: "setupSync",
        intervalMinutes: 0
      });
    }

    // Setup timeline alarm if interval is set
    if (settings.timelineInterval > 0) {
      await chrome.runtime.sendMessage({
        action: "setupTimeline",
        intervalMinutes:
          settings.timelineInterval
      });
    } else {
      await chrome.runtime.sendMessage({
        action: "setupTimeline",
        intervalMinutes: 0
      });
    }

    showMessage(
      "✅ Settings saved. Triggering initial sync...",
      "success"
    );

    // Initial sync to GitHub
    try {
      const syncResponse = await chrome.runtime.sendMessage({
        action: "saveSession"
      });
      if (syncResponse && syncResponse.success) {
        showMessage("✅ Profile initialized on GitHub!", "success");
      } else {
        showMessage(`⚠️ Settings saved, but sync failed: ${syncResponse?.error || "Unknown error"}`, "error");
      }
    } catch (e) {
      showMessage(`⚠️ Settings saved, but could not connect to background: ${e.message}`, "error");
    }

    return true;
  } catch (error) {
    console.error(
      "Error saving settings:",
      error
    );
    showMessage(
      `Error: ${error.message}`,
      "error"
    );
    return false;
  }
}

/**
 * Test GitHub connection
 */
async function testConnection() {
  const btn = document.getElementById(
    "testConnection"
  );
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "⏳ Testing...";

  try {
    const username = document
      .getElementById("githubUsername")
      .value.trim();
    const repo = document
      .getElementById("githubRepo")
      .value.trim();
    const token = document
      .getElementById("githubToken")
      .value.trim();

    if (!username || !repo || !token) {
      showMessage(
        "Please fill in GitHub credentials first",
        "error"
      );
      btn.disabled = false;
      btn.textContent = originalText;
      return;
    }

    // Test API call - verify repository exists
    const response = await fetch(
      `https://api.github.com/repos/${username}/${repo}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept:
            "application/vnd.github.v3+json"
        }
      }
    );

    if (response.ok) {
      const repoData =
        await response.json();
      if (repoData.private) {
        showMessage(
          `✅ Connected! Repo: ${repoData.full_name} (private: ${repoData.private})`,
          "success"
        );
      } else {
        showMessage(
          `⚠️ Repository is public. For security, consider making it private.`,
          "warning"
        );
      }
    } else if (
      response.status === 401
    ) {
      showMessage(
        "❌ Unauthorized - Check your token",
        "error"
      );
    } else if (
      response.status === 404
    ) {
      showMessage(
        "❌ Repository not found - Check username and repo name",
        "error"
      );
    } else {
      const error =
        await response.json();
      showMessage(
        `❌ Error: ${error.message}`,
        "error"
      );
    }
  } catch (error) {
    console.error(
      "Error testing connection:",
      error
    );
    showMessage(
      `❌ Connection failed: ${error.message}`,
      "error"
    );
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/**
 * Show message to user
 */
function showMessage(
  text,
  type = "info"
) {
  const messageEl =
    document.getElementById(MESSAGE_ID);
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;

  // Auto-hide success messages after 3 seconds
  if (type === "success") {
    setTimeout(() => {
      messageEl.textContent = "";
      messageEl.className = "message";
    }, 3000);
  }
}

/**
 * Toggle password visibility
 */
function togglePasswordVisibility() {
  const tokenInput =
    document.getElementById(
      "githubToken"
    );
  const showCheckbox =
    document.getElementById(
      "showToken"
    );

  if (showCheckbox.checked) {
    tokenInput.type = "text";
  } else {
    tokenInput.type = "password";
  }
}

function syncProfileKeyFromName() {
  const profileNameInput =
    document.getElementById(
      "profileName"
    );
  const profileKeyInput =
    document.getElementById(
      "profileKey"
    );

  if (
    profileKeyInput.dataset.touched ===
    "true"
  ) {
    return;
  }

  profileKeyInput.value =
    slugifyProfileKey(
      profileNameInput.value
    );
}

// Event listeners
document
  .getElementById(FORM_ID)
  .addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings();
  });

document
  .getElementById("testConnection")
  .addEventListener(
    "click",
    testConnection
  );

document
  .getElementById("showToken")
  .addEventListener(
    "change",
    togglePasswordVisibility
  );

document
  .getElementById("profileName")
  .addEventListener(
    "input",
    syncProfileKeyFromName
  );

document
  .getElementById("profileKey")
  .addEventListener("input", (e) => {
    e.target.dataset.touched =
      e.target.value.trim() ? "true" : "false";
    e.target.value = slugifyProfileKey(
      e.target.value
    );
  });

// Load settings on page load
document.addEventListener(
  "DOMContentLoaded",
  async () => {
    await applyStoredTheme();
    await loadSettings();
  }
);
