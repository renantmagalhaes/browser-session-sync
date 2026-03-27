# Development Guide

This guide explains the architecture and how to extend the Browser Session Sync extension.

## Architecture Overview

### High-Level Flow

```
User Action (popup/options)
    ↓
Message to background.js via chrome.runtime.sendMessage()
    ↓
Background Service Worker processes request
    ↓
GitHub API call (if needed)
    ↓
Response sent back to popup/options
    ↓
UI updates with result
```

### File Responsibilities

| File               | Purpose                 | Key Functions                                 |
| ------------------ | ----------------------- | --------------------------------------------- |
| `manifest.json`    | Extension configuration | Declares permissions, service worker, UIs     |
| `background.js`    | Service Worker          | Core logic: sync, API calls, message handling |
| `popup.html/.js`   | Main UI                 | Display sessions, restore, manual sync        |
| `options.html/.js` | Settings UI             | Configure credentials, intervals, profiles    |
| `styles.css`       | Shared styles           | Styling for popup and options pages           |

## Data Flow

### Saving a Session

```
popup.js: syncNow()
    ↓ sendMessage('saveSession')
background.js: getMessage listener
    ↓ saveSessionToGitHub()
    ↓ Collect tabs from chrome.windows.getAll()
    ↓ Create JSON payload
    ↓ Base64 encode
    ↓ GitHub API: PUT /repos/.../contents/...
    ↓ Store lastSyncTime
Response → popup.js → updateStatus()
```

### Restoring a Session

```
popup.js: restoreSession(path)
    ↓ sendMessage('restoreSession', {sessionPath})
background.js: getMessage listener
    ↓ Fetch from GitHub API
    ↓ Base64 decode
    ↓ Parse JSON
    ↓ chrome.windows.create() with URLs
Response → popup.js → Alert user
```

### Auto Sync

```
Every N minutes (chrome.alarms):
    ↓ Alarm fires: 'sessionSync'
    ↓ background.js: onAlarm listener
    ↓ saveSessionToGitHub()
    ↓ Updates lastSyncTime
```

## Storage Architecture

### Chrome Storage API Usage

**chrome.storage.sync** (settings - syncs across devices)

```javascript
{
  githubUsername: string,
  githubRepo: string,
  githubToken: string,
  profileName: string,
  syncInterval: number,
  excludeLocalTabs: boolean,
  lastSyncTime: ISO string,
  lastSyncStatus: string
}
```

**chrome.storage.local** (device-specific)

```javascript
{
  clientId: UUID string
}
```

## Message Protocol

### Available Messages

**From popup/options to background:**

```javascript
// Save current session
chrome.runtime.sendMessage({
  action: "saveSession"
});
// Response: { success: bool, filePath?: string, error?: string }

// Get all sessions
chrome.runtime.sendMessage({
  action: "listSessions"
});
// Response: { success: bool, sessions: Array<SessionData>, error?: string }

// Restore specific session
chrome.runtime.sendMessage({
  action: "restoreSession",
  sessionPath:
    "sessions/clientId/session-timestamp.json"
});
// Response: { success: bool, sessionRestored?: string, error?: string }

// Get current status
chrome.runtime.sendMessage({
  action: "getStatus"
});
// Response: { lastSyncTime?: string, lastSyncStatus?: string, clientId: string }

// Setup alarm
chrome.runtime.sendMessage({
  action: "setupSync",
  intervalMinutes: number
});
// Response: { success: bool }
```

## Key Functions

### background.js

```javascript
// Initialization
initializeClientId()                    // Create/retrieve unique ID
getGitHubHeaders()                      // Build auth headers
getRepoUrl()                            // Construct repo URL

// Core functionality
saveSessionToGitHub()                   // Save current tabs to GitHub
listAllSessions()                       // Fetch all sessions from GitHub
restoreSession(sessionPath)             // Open tabs from session

// Utilities
setupSyncAlarm(intervalMinutes)         // Create/clear chrome alarm
chrome.alarms.onAlarm listener          // Handle periodic syncs
chrome.runtime.onMessage listener       // Handle popup/options requests
```

### popup.js

```javascript
updateStatus(); // Fetch and display sync status
loadSessions(); // Load sessions from background
displaySessions(sessions); // Render sessions to DOM
createSessionElement(session); // Create DOM element for session
filterSessions(searchTerm); // Filter by search query
restoreSession(sessionPath); // Request restore from background
syncNow(); // Request save from background
escapeHtml(text); // Prevent XSS
```

### options.js

```javascript
loadSettings(); // Load saved settings into form
saveSettings(); // Save form to chrome.storage.sync
testConnection(); // Verify GitHub connection
showMessage(text, type); // Display status message
togglePasswordVisibility(); // Toggle password field type
```

## GitHub API Integration

### Authentication

All requests use:

```javascript
Headers: {
  'Authorization': `token ${ghToken}`,
  'Accept': 'application/vnd.github.v3+json',
  'Content-Type': 'application/json'
}
```

### Endpoints Used

**List files in directory:**

```
GET /repos/{owner}/{repo}/contents/{path}
Response: Array of file objects with type, path, url, content (base64)
```

**Create/Update file:**

```
PUT /repos/{owner}/{repo}/contents/{path}
Body: { message: string, content: base64string }
```

### Base64 Encoding/Decoding

Encode (UTF-8):

```javascript
const content = JSON.stringify(
  sessionData
);
const encoded = btoa(
  unescape(encodeURIComponent(content))
);
```

Decode (UTF-8):

```javascript
const decoded = decodeURIComponent(
  escape(atob(content))
);
const sessionData = JSON.parse(decoded);
```

## Debugging

### Enable Logging

Add to any function:

```javascript
console.log("Debug message:", variable);
```

### View Service Worker Logs

1. Go to `chrome://extensions/`
2. Click "Service workers" → "Inactive"
3. Click on "browser-session-sync"
4. Logs appear in DevTools Console

### View Popup/Options Logs

1. Right-click extension icon
2. Click "Inspect popup" or "Inspect options"
3. View Console tab

### Check Stored Data

In DevTools Console:

```javascript
// View sync storage
chrome.storage.sync.get(null, (items) =>
  console.log(items)
);

// View local storage
chrome.storage.local.get(
  null,
  (items) => console.log(items)
);

// View alarms
chrome.alarms.getAll((alarms) =>
  console.log(alarms)
);
```

## Common Modifications

### Change Default Sync Interval

Edit `options.html`:

```html
<input
  type="number"
  id="syncInterval"
  min="0"
  max="1440"
  value="60"
/>
```

Change `value="60"` to desired minutes.

### Add More Session Metadata

Edit session data structure in `background.js`:

```javascript
const sessionData = {
  timestamp: new Date().toISOString(),
  browserAlias: alias,
  clientId: clientId,
  tabCount: tabCount,  // Add this
  windows: windows.map(...)
};
```

Then update display in `popup.js` to show the new field.

### Filter Out URLs

Edit `background.js` `saveSessionToGitHub()`:

```javascript
const tabs = w.tabs
  .filter(t => t.url && (
    t.url.startsWith('http://') ||
    t.url.startsWith('https://')
  ))
  .map(t => ({ ... }));
```

### Change Search Behavior

Edit `popup.js` `filterSessions()` function to add more search fields:

```javascript
if (data.timestamp.includes(term))
  return true; // Search by date
if (
  data.windows.length
    .toString()
    .includes(term)
)
  return true; // Search by count
```

## Testing Checklist

- [ ] Sync works with test session
- [ ] Sessions restore correctly
- [ ] Search filters sessions
- [ ] Auto-sync triggers at interval
- [ ] Settings persist across reload
- [ ] Token auth works
- [ ] Error handling for network failures
- [ ] UI updates after actions
- [ ] No console errors

## Performance Considerations

- **Large sessions**: Sessions with 100+ tabs create larger JSON files
  - GitHub API has file size limits
  - Consider filtering out tabs
- **Frequent syncs**: High sync frequency increases GitHub API rate limiting
  - Default 30 minutes is reasonable
- **Session list**: Building DOM for many sessions is slow
  - Consider pagination for large lists
  - Search filtering improves performance

## Security Notes for Developers

- **Never log credentials**: Don't console.log tokens or passwords
- **Use HTTPS only**: All GitHub API calls are HTTPS
- **Validate input**: Check user input before using in API calls
- **Sanitize HTML**: Use `escapeHtml()` to prevent XSS
- **Token scope**: Keep token scope minimal (only `repo`)

## Extension Limitations to Know

1. **Content Scripts**: The extension cannot run content scripts on every page
   - Only service worker and popups/options can run
   - Cannot modify page content

2. **Chrome Alarms**: Not guaranteed to fire at exact times
   - Resolution is at least 1 minute
   - May fire later under certain conditions

3. **Tab Data**: Limited info available from `chrome.tabs.get()`
   - Only title, URL, favicon available
   - No page content or DOM access

4. **Storage Quota**: Limited by Chrome storage API
   - sync storage: ~100KB per item, ~360KB total
   - We only store settings (small), not session data

## Future Enhancement Ideas

1. **Encryption**: Encrypt session data before sending to GitHub
2. **Compression**: Compress large sessions
3. **Selective Restore**: Checkbox to choose which tabs to restore
4. **Session Tags**: Tag and categorize sessions
5. **Diff View**: Compare two sessions
6. **Scheduled Backups**: Set specific backup times (e.g., end of day)
7. **Export/Import**: Backup settings and sessions locally
8. **Multiple Repos**: Store different types of sessions in different repos
9. **Session Notes**: Add user notes to sessions
10. **Browser Sync**: Sync between Chrome and other browsers (Brave, Edge, etc.)

## Resources

- [Chrome Extension Manifest V3 Docs](https://developer.chrome.com/docs/extensions/mv3/)
- [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/storage/)
- [Chrome Windows API](https://developer.chrome.com/docs/extensions/reference/windows/)
- [Chrome Alarms API](https://developer.chrome.com/docs/extensions/reference/alarms/)
- [GitHub REST API v3](https://docs.github.com/en/rest)
- [GitHub Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token)
