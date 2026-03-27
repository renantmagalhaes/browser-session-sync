# Browser Session Sync - Chrome Extension

A Chrome Extension (Manifest V3) that saves and restores browser sessions to a private GitHub repository. Seamlessly backup your open tabs and windows across multiple browsers using your GitHub account as a remote data store.

## Features

✨ **Session Management**

- 💾 Save current browser session (all open windows and tabs)
- 📂 Restore any previously saved session
- 🔍 Search sessions by browser profile, tab title, or URL
- 📋 View session previews with tab counts

🔄 **Automated Syncing**

- ⏱️ Configurable auto-sync intervals (0 to 1440 minutes)
- 🖱️ Manual "Sync Now" button in popup
- 🔔 Real-time sync status indicators

🔐 **Multi-Profile Support**

- 🆔 Automatic unique client ID generation
- 📝 Custom browser aliases (e.g., "Work Laptop", "Personal iMac")
- 📊 Track sessions from multiple browsers simultaneously

🌐 **GitHub Integration**

- 🔑 Secure PAT (Personal Access Token) authentication
- 📦 Organized session storage: `sessions/{clientId}/session-{timestamp}.json`
- ✅ Connection testing before saving
- 🔒 Support for private repositories only

💻 **Technical**

- Manifest V3 compatible
- Service Worker background syncing
- Chrome Storage API for configuration
- GitHub REST API v3 integration

## Installation

### Prerequisites

- Google Chrome browser (version 88+)
- GitHub account
- Private GitHub repository (create one for session storage)

### Setup Steps

#### 1. Create a Private GitHub Repository

1. Go to [GitHub](https://github.com/new)
2. Create a new private repository (e.g., `my-sessions-repo`)
3. Leave it empty - the extension will create the necessary structure

#### 2. Generate a GitHub Personal Access Token

1. Visit [GitHub Settings → Personal access tokens](https://github.com/settings/tokens)
2. Click "Generate new token"
3. Give it a descriptive name (e.g., "Browser Session Sync")
4. Select **ONLY** the `repo` scope (full control of private repositories)
5. Set expiration as needed
6. Copy the token (you won't be able to see it again!)

#### 3. Load the Extension in Chrome

1. Clone this repository or download the files
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the extension folder
6. The extension icon should appear in your toolbar

#### 4. Configure the Extension

1. Click the extension icon in the toolbar
2. Click the ⚙️ settings button
3. Fill in your GitHub credentials:
   - **GitHub Username**: Your GitHub username
   - **Repository Name**: The name of your sessions repository
   - **Personal Access Token**: The token you generated
4. Add a browser profile name (e.g., "Work Laptop")
5. Set your preferred auto-sync interval (recommended: 30 minutes)
6. Click "Test Connection" to verify everything works
7. Click "Save Settings"

## Usage

### Saving Sessions

**Automatic Syncing**

- Once configured, the extension will automatically save your session at the interval you set
- Disable auto-sync by setting the interval to 0

**Manual Sync**

1. Click the extension icon
2. Click "💾 Sync Now"
3. The status will show when the sync completes

### Restoring Sessions

1. Click the extension icon
2. Browse the list of saved sessions
3. Use the search bar to filter by:
   - Browser profile name
   - Tab title
   - Tab URL
4. Click "📂 Restore" on any session
5. A new window will open with all tabs from that session

### Searching Sessions

The search box filters sessions in real-time by:

- Browser alias (profile name)
- Tab titles
- URLs

Example searches:

- "Work" - finds sessions from browsers named "Work..."
- "github.com" - finds sessions with GitHub tabs
- "local" - finds tabs on localhost

## Data Storage

### Directory Structure

Sessions are stored in the GitHub repository with the following structure:

```
repository/
└── sessions/
    ├── {clientId1}/
    │   ├── session-1711104000000.json
    │   ├── session-1711107600000.json
    │   └── session-1711111200000.json
    └── {clientId2}/
        ├── session-1711104000000.json
        └── session-1711107600000.json
```

### Session Data Format

Each `session-{timestamp}.json` file contains:

```json
{
  "timestamp": "2024-03-27T10:00:00.000Z",
  "browserAlias": "Work Laptop",
  "clientId": "550e8400-e29b-41d4-a716-446655440000",
  "windows": [
    {
      "id": 1,
      "tabs": [
        {
          "title": "GitHub",
          "url": "https://github.com",
          "active": true
        },
        {
          "title": "Google",
          "url": "https://google.com",
          "active": false
        }
      ]
    }
  ]
}
```

## Settings

All settings are stored in Chrome's sync storage and sync across your logged-in Chrome instances.

| Setting                   | Description                                    | Default                     |
| ------------------------- | ---------------------------------------------- | --------------------------- |
| **GitHub Username**       | Your GitHub username                           | -                           |
| **Repository Name**       | Your sessions repository name                  | -                           |
| **Personal Access Token** | GitHub PAT for authentication                  | -                           |
| **Profile Name**          | Friendly name for this browser                 | "Default Browser"           |
| **Auto-sync Interval**    | Minutes between automatic saves (0 to disable) | 30                          |
| **Exclude Local Tabs**    | Filter out localhost and file:// URLs          | Off                         |
| **Client ID**             | Auto-generated unique identifier               | Auto-generated on first run |

## Security Considerations

⚠️ **Important Security Notes:**

1. **Repository Privacy**: Always use a **private** repository. The extension will warn if you use a public repository.

2. **Token Security**:
   - The GitHub PAT is stored in Chrome's sync storage
   - Treat it like a password
   - Use minimal scopes: only `repo` is needed
   - Regenerate tokens if compromised

3. **Data Privacy**:
   - Tab data is Base64 encoded before transmission
   - Only URLs and titles are stored (not page content)
   - All API calls use HTTPS
   - Authenticate with GitHub using only your PAT

4. **Multi-Device Sync**:
   - Different devices get different Client IDs
   - Sessions are organized by Client ID
   - You control which devices' sessions are stored

5. **Token Rotation**:
   - Periodically rotate your GitHub PAT for security
   - Regenerate in GitHub Settings → Personal access tokens

## Troubleshooting

### Connection Test Fails

**401 Unauthorized**

- Check your GitHub token is correct
- Verify the token hasn't expired
- Ensure it has the `repo` scope

**404 Not Found**

- Verify your GitHub username is correct
- Check the repository name exists
- Ensure the repository is accessible to your account

**Fetch Error**

- Check your internet connection
- Verify GitHub API is accessible
- Check for browser network restrictions

### Sessions Not Syncing

**Auto-sync not working**

- Check the sync interval isn't set to 0
- Verify GitHub credentials are saved
- Check browser console for errors (F12 → Console)

**Manual sync fails**

- Test the connection first (Settings → Test Connection)
- Ensure GitHub credentials are correct
- Check internet connection

### Sessions Won't Restore

**Can't open restored tabs**

- Some URLs might be invalid
- Protocol might have changed (http vs https)
- Page might have moved or been deleted
- Check if localhost URLs are still accessible

### Can't Find Sessions

**Use the search feature**

- Search is case-insensitive
- Try searching for domain names (github.com, localhost)
- Check the sync date to find recent sessions
- Each browser has its own folder (different Client ID)

## Architecture

### Files Structure

```
browser-session-sync-codex/
├── manifest.json          # Extension configuration
├── background.js          # Service Worker (sync logic, API calls)
├── popup.html            # Main popup UI
├── popup.js              # Popup interactions & session restore
├── options.html          # Settings page
├── options.js            # Settings management
├── styles.css            # Shared styles for popup and options
├── images/
│   ├── icon-16.png       # 16x16 icon
│   ├── icon-48.png       # 48x48 icon
│   └── icon-128.png      # 128x128 icon
└── README.md             # This file
```

### Key Components

**Background Service Worker** (`background.js`)

- Manages periodic syncing with Chrome Alarms
- Handles GitHub API calls (PUT, GET)
- Base64 encodes/decodes session data
- Processes messages from popup
- Restores sessions by opening windows/tabs

**Popup** (`popup.html` + `popup.js`)

- Displays list of saved sessions
- Real-time search/filtering
- "Sync Now" button for manual save
- "Restore" buttons for each session
- Status indicators and last sync time

**Options/Settings** (`options.html` + `options.js`)

- GitHub credential configuration
- Profile naming
- Auto-sync interval setup
- Connection testing
- Settings persistence

## API Usage

The extension uses the GitHub REST API v3:

### Endpoints

- `GET /repos/{owner}/{repo}/contents/sessions` - List session folders
- `GET /repos/{owner}/{repo}/contents/sessions/{clientId}` - List client's sessions
- `GET /repos/{owner}/{repo}/contents/{path}` - Fetch session file
- `PUT /repos/{owner}/{repo}/contents/{path}` - Create/update session file

### Authentication

- Uses GitHub Personal Access Token
- Includes token in `Authorization: token {PAT}` header
- All requests use HTTPS

## Limitations

- ⏱️ Chrome Alarms are not guaranteed to run at exact intervals
- 🌐 Localhost and file:// URLs are saved but may not be accessible on other machines
- 📊 GitHub API rate limits (60 requests/hour per IP, 5000/hour authenticated)
- 💾 GitHub file size limits (each session file should typically be < 1MB)
- 🔒 Requires active internet connection for syncing

## Contributing

This is an open-source extension. Contributions are welcome!

Potential improvements:

- Tag/categorize sessions
- Encrypted session data option
- Session diff/comparison
- Selective tab restore
- Session sharing between users
- Alternative storage backends (Google Drive, Dropbox, etc.)
- Improved icon design

## License

MIT License - Feel free to use, modify, and distribute.

## FAQ

**Q: Is my data secure?**
A: Your session data is stored in your own private GitHub repository. Only URLs and titles are saved (not page content). The GitHub PAT should be treated like a password.

**Q: Can I use a public repository?**
A: You can, but it's not recommended. The extension warns if you use a public repo. Anyone with repo access could see your tab history.

**Q: How much data can I store?**
A: GitHub files are typically limited to 100MB, but each session should be much smaller. You're also subject to GitHub API rate limits.

**Q: What happens if I lose my GitHub token?**
A: Generate a new one in GitHub Settings. Update the extension settings with the new token.

**Q: Can I restore sessions between different browsers?**
A: Yes! Sessions are organized by Client ID. Each browser gets a unique ID, but you can restore any session from any client.

**Q: Does it work offline?**
A: No, syncing requires internet. Populating the session list also requires internet.

**Q: Can I backup the extension settings?**
A: Settings are stored in Chrome's sync storage. If you're signed into Chrome, they sync across devices. You can also export settings from the options page.

## Support

For issues, feature requests, or questions:

1. Check the Troubleshooting section above
2. Check the GitHub Issues page
3. Review the manifest and permissions in `manifest.json`
4. Check browser console (F12 → Console) for error messages

## Changelog

### Version 1.0.0 (Initial Release)

- Full Manifest V3 implementation
- Session save/restore functionality
- GitHub integration with PAT authentication
- Multi-profile support with unique Client IDs
- Automatic and manual syncing
- Session search and filtering
- Settings page with connection testing
- Status indicators and last sync timestamps
