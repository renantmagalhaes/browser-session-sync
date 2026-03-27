# Browser Session Sync

A Chrome Extension (Manifest V3) that syncs browser sessions to a private GitHub repository and restores them across machines.

It is designed around two separate concepts:

- `Current session`: the latest state of a profile, continuously updated
- `Snapshots`: explicit or daily history checkpoints

## Features

### Session Sync

- Sync the current browser session to GitHub
- Restore saved sessions from any configured profile
- Save manual snapshots for important checkpoints
- Create at most one automatic history snapshot per day per profile

### Multi-Profile Support

- Auto-generated internal `clientId`
- User-defined `Profile Name` for display
- User-defined `Profile Folder` for readable GitHub paths
- Filter the popup by current profile or switch to `All Profiles`

### Search and Restore

- Search by profile name, tab title, or URL
- Search respects the selected profile filter
- Restore opens saved URLs into new browser windows

### GitHub Storage

- Uses the GitHub Contents API
- Supports private repositories
- Stores `latest.json`, history snapshots, and a shared index
- Rebuilds the index if repository files were manually deleted

### UI

- Popup optimized for Chrome’s limited extension popup space
- Expandable session details to reduce vertical noise
- Explicit light/dark theme toggle in the popup
- Shared themed styling across popup and options page

## How It Works

### Current Session vs Snapshot

`Update Current`

- Updates `latest.json` for the selected profile folder
- Does not create a new history file on every sync
- Skips writing if the session did not change

`Save Snapshot`

- Forces a history checkpoint immediately

Automatic daily snapshot

- When the current session is updated, a history snapshot is created only if:
  - there is no snapshot yet for that profile, or
  - the latest snapshot for that profile is from a different calendar day

This keeps GitHub storage manageable while still preserving useful history.

## Repository Structure

Sessions are stored in your GitHub repository like this:

```text
repository/
└── sessions/
    ├── index.json
    ├── work-laptop/
    │   ├── latest.json
    │   └── history/
    │       ├── session-1711104000000.json
    │       └── session-1711190400000.json
    └── personal-imac/
        ├── latest.json
        └── history/
            └── session-1711107600000.json
```

### File Meanings

- `sessions/index.json`
  - compact shared index used by the popup for fast listing and search
- `sessions/{profileFolder}/latest.json`
  - current live state for that profile
- `sessions/{profileFolder}/history/session-{timestamp}.json`
  - history checkpoints

### Session JSON Format

```json
{
  "timestamp": "2026-03-27T15:13:43.000Z",
  "browserAlias": "RTM",
  "profileKey": "rtm",
  "clientId": "550e8400-e29b-41d4-a716-446655440000",
  "signature": "session-content-hash",
  "windows": [
    {
      "id": 1,
      "tabs": [
        {
          "title": "GitHub",
          "url": "https://github.com",
          "active": true
        }
      ]
    }
  ]
}
```

## Installation

### Prerequisites

- Google Chrome
- GitHub account
- Private GitHub repository
- Fine-grained GitHub Personal Access Token

### GitHub Token Requirements

Use a **Fine-grained personal access token** with:

- `Metadata`: `Read-only`
- `Contents / Code`: `Read and write`

That maps to:

- `Read access to metadata`
- `Read and Write access to code`

### Setup

1. Create an empty private GitHub repository.
2. Create a fine-grained GitHub Personal Access Token with:
   - Read access to metadata
   - Read and Write access to code
3. Open `chrome://extensions/`.
4. Enable Developer mode.
5. Click `Load unpacked`.
6. Select this project folder.
7. Open the extension popup.
8. Open Settings.
9. Fill in:
   - GitHub Username
   - Repository Name
   - Personal Access Token
   - Profile Name
   - Profile Folder
   - Auto-sync interval
10. Save settings.

If you want a shorter install walkthrough, see [QUICKSTART.md](./QUICKSTART.md).

## Settings

| Setting                 | Description                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| `GitHub Username`       | GitHub account that owns the repository                                   |
| `Repository Name`       | Private repository used for storage                                       |
| `Personal Access Token` | GitHub token used for API access                                          |
| `Profile Name`          | Human-readable display name shown in the UI                               |
| `Profile Folder`        | Stable folder key used in GitHub paths, for example `work-laptop`         |
| `Auto-sync Interval`    | Minutes between automatic current-session updates, `0` disables auto-sync |
| `Client ID`             | Internal auto-generated identifier stored locally                         |

## Popup Behavior

The popup includes:

- `Update Current`
- `Save Snapshot`
- `Refresh`
- profile filter with `All Profiles`
- search input
- session cards with compact restore action
- collapsible session details
- theme toggle

By default, the popup shows only the current profile’s sessions if that profile exists in the index.

## Search Behavior

Search runs against the currently selected profile scope.

If the profile filter is set to:

- a specific profile: search is limited to that profile
- `All Profiles`: search runs across all indexed sessions

Search matches:

- profile name
- tab title
- tab URL

## Restore Behavior

When you click `Restore`:

- the extension fetches the selected session JSON from GitHub
- it opens saved HTTP/HTTPS URLs in new windows

The popup uses the shared index for listing/search and fetches full JSON only when restoring.

## Theme

The extension supports explicit light and dark themes.

- Use the theme toggle in the popup header
- Theme preference is stored and reused by the popup and options page

## Security Notes

- Use a private repository
- Treat your GitHub PAT like a password
- Only URLs and tab titles are stored, not page contents
- All GitHub API calls use HTTPS

## Limitations

- Chrome alarm timing is approximate
- Local URLs such as `localhost` or `file://` may not restore meaningfully on another machine
- GitHub API rate limits still apply
- Syncing and listing sessions require internet access

## Architecture

```text
browser-session-sync-codex/
├── manifest.json
├── background.js
├── popup.html
├── popup.js
├── options.html
├── options.js
├── styles.css
├── images/
└── README.md
```

### Main Files

`background.js`

- handles GitHub API access
- stores and updates `latest.json`
- creates daily/manual snapshots
- maintains `sessions/index.json`
- restores sessions
- manages auto-sync alarms

`popup.js`

- renders indexed sessions
- filters by profile and search term
- triggers restore, update, and snapshot actions
- manages popup theme toggle

`options.js`

- saves GitHub credentials and profile settings
- configures auto-sync interval
- applies stored theme to the options page

## Troubleshooting

### Popup opens but sessions are missing

- Verify GitHub credentials in Settings
- Click `Refresh`
- Confirm the selected profile filter is correct
- Try `All Profiles`

### Manual GitHub cleanup caused sync issues

The extension now retries GitHub writes and can rebuild its session index after manual repo deletions. If needed:

1. Reload the extension in `chrome://extensions/`
2. Click `Update Current`
3. Click `Refresh`

### Restore opens fewer tabs than expected

- Only valid HTTP/HTTPS URLs are restored
- browser-internal pages and some local URLs are skipped

## License

MIT
