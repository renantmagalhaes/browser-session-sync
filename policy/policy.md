# Privacy Policy

**Effective Date:** March 27, 2026

This Chrome extension, **Browser Session Sync**, helps users save and restore browser sessions using a GitHub repository they configure themselves.

## What Data the Extension Accesses

The extension accesses:

- open browser windows and tabs
- tab titles and URLs
- extension settings stored in Chrome storage
- GitHub account configuration provided by the user

## What Data Is Stored

### Stored in Chrome Storage

The extension stores configuration and local state in Chrome storage, including:

- GitHub username
- GitHub repository name
- GitHub Personal Access Token
- profile name
- profile folder
- auto-sync interval
- generated client ID
- theme preference
- sync status metadata

### Stored in the User’s GitHub Repository

When the user chooses to sync sessions, the extension stores session data in the GitHub repository configured by the user. That data can include:

- tab titles
- tab URLs
- timestamps
- profile name
- profile folder key
- client ID
- window and tab structure

Session data is stored in files such as:

- `sessions/{profileFolder}/latest.json`
- `sessions/{profileFolder}/history/session-{timestamp}.json`
- `sessions/index.json`

## How Data Is Used

The extension uses this data only to:

- sync the user’s current browser session
- create optional history snapshots
- list and search saved sessions
- restore saved sessions on demand
- authenticate GitHub API requests on behalf of the user

## Data Transmission

The extension transmits data to:

- **GitHub API**, for reading and writing session files in the user’s configured repository

The extension does not transmit session data to the developer or to any third-party analytics or advertising service.

## Data Sharing

The developer does not receive or store user session data.

However, session data is written to the GitHub repository chosen by the user, so access to that data depends on the privacy and access controls of that repository and the associated GitHub account.

## User Control

Users control:

- whether the extension is configured at all
- which GitHub repository is used
- whether auto-sync is enabled
- when to update the current session
- when to create a snapshot
- which profile folder is used
- whether to delete repository data manually

Users can stop syncing at any time by removing the token, disabling auto-sync, or uninstalling the extension.

## Security Notes

- The extension is intended to be used with a **private GitHub repository**
- The GitHub token should be treated like a password
- Only the repository configured by the user is used for remote storage
- The extension uses HTTPS requests to communicate with GitHub

## Changes to This Policy

This policy may be updated if the extension’s behavior changes.

## Contact

If you have questions about this policy, contact:

- Email: rtm@insecure.codes
- GitHub: https://github.com/renantmagalhaes
