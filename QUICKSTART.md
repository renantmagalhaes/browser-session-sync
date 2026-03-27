# Quick Start Guide

Get your Browser Session Sync extension running in 5 minutes!

## 📋 Prerequisites (2 minutes)

1. **GitHub Account** - [Sign up free](https://github.com/signup)
2. **Google Chrome** - Version 88 or later
3. **This Extension** - Cloned or downloaded locally

## 🚀 Setup (3 minutes total)

### Step 1: Create GitHub Repository (30 seconds)

```bash
1. Visit https://github.com/new
2. Repository name: my-sessions-repo
3. Select "Private"
4. Click "Create repository"
```

### Step 2: Generate Personal Access Token (1 minute)

```bash
1. Visit https://github.com/settings/tokens
2. Choose "Fine-grained personal access tokens"
3. Click "Generate new token"
4. Name: "Browser Session Sync"
5. Repository access: select the repository you created
6. Permissions:
   - Metadata: Read-only
   - Contents / Code: Read and write
7. Click "Generate token"
8. Copy the token (save it somewhere - you won't see it again!)
```

Required permissions:

- Read access to metadata
- Read and Write access to code

### Step 3: Load Extension in Chrome (1 minute)

```bash
1. Open Chrome and go to: chrome://extensions/
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select this extension folder
5. Done! Extension icon appears in toolbar
```

### Step 4: Configure Extension (30 seconds)

1. Click extension icon → ⚙️ Settings
2. Fill in:
   - **GitHub Username**: your-username
   - **Repository Name**: my-sessions-repo
   - **Personal Access Token**: (paste token from Step 2)
   - **Profile Name**: My Laptop
   - **Profile Folder**: my-laptop
3. Click "Test Connection" to verify
4. Click "Save Settings"

✅ **All set! Your extension is ready to use.**

## 💾 Using the Extension

### Update Your Current Session

- Click extension icon
- Click "Update Current"
- This updates `latest.json` for the current profile

### Save a Snapshot

- Click extension icon
- Click "Save Snapshot"
- Use this when you want an explicit checkpoint

### Restore a Previous Session

- Click extension icon
- Find session in list
- Click "Restore"
- New window opens with all tabs

### Find Sessions

- Use the profile filter to switch between the current profile and `All Profiles`
- Use search to filter by:
  - Profile name
  - Website
  - Page title

## ⚙️ Recommended Settings

- **Auto-sync Interval**: `30` minutes is a good default
- **Profile Name**: human-readable label, for example `Work Laptop`
- **Profile Folder**: stable GitHub folder name, for example `work-laptop`

## 🆘 Troubleshooting

### "401 Unauthorized" Error

→ Check your GitHub token is correct and still has the required permissions

### "404 Not Found" Error

→ Verify your username and repository name are correct

### "Fetch Error"

→ Check internet connection and GitHub API accessibility

### Sessions not syncing automatically

→ Go to Settings and set Auto-sync Interval to > 0

### Can't restore a session

→ Check if all URLs are still valid and accessible

## 📚 Learn More

- **Full Documentation**: Read [README.md](README.md)
- **Troubleshooting**: [README.md - Troubleshooting section](README.md#troubleshooting)
- **Architecture and behavior**: [README.md](README.md#how-it-works)

## 🔐 Security Checklist

- [ ] Created PRIVATE repository
- [ ] Used a Fine-grained personal access token
- [ ] Granted Read access to metadata
- [ ] Granted Read and Write access to code
- [ ] Tested connection successfully
- [ ] Token is not shared anywhere
- [ ] Browser profile name and folder are set

---

**Ready to start?** → Click the extension icon and hit "Update Current" to sync your first session.
