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
2. Click "Generate new token"
3. Name: "Browser Session Sync"
4. Scopes: Select ONLY "repo" checkbox
5. Click "Generate token"
6. Copy the token (save it somewhere - you won't see it again!)
```

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
   - **Profile Name**: My Laptop (optional)
3. Click "Test Connection" to verify
4. Click "Save Settings"

✅ **All set! Your extension is ready to use.**

## 💾 Using the Extension

### Save Your Current Session

- Click extension icon
- Click "💾 Sync Now"
- Status updates when done

### Restore a Previous Session

- Click extension icon
- Find session in list
- Click "📂 Restore"
- New window opens with all tabs

### Find Sessions

- Use search box to filter by:
  - Profile name (e.g., "Work")
  - Website (e.g., "github.com")
  - Page title (e.g., "GitHub")

## ⚙️ Optional Settings

**Auto-sync Interval** (Default: 30 minutes)

- Set to desired minutes
- Set to 0 to disable auto-sync
- Recommend: 30 minutes

**Exclude Local Tabs**

- Check to ignore localhost and file:// URLs
- Useful if you have many local projects

**Profile Name**

- Give this browser a nickname
- Useful when syncing across multiple browsers

## 🔍 Monitor Sync Status

In the popup, you'll see:

- ✅ **Ready to sync** - Everything working
- ⚠️ **Error message** - Check connection/credentials
- 📡 **No sync yet** - First-time setup
- **Last sync timestamp** - When it last ran

## 🆘 Troubleshooting

### "401 Unauthorized" Error

→ Check your GitHub token is correct and hasn't expired

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
- **Security**: [README.md - Security Considerations](README.md#security-considerations)
- **API Details**: [README.md - API Usage](README.md#api-usage)

## 💡 Pro Tips

1. **Backup Multiple Browsers**: Install on work and personal browsers - each gets its own folder
2. **Use Descriptive Names**: Set profile names like "Work Laptop", "Home Desktop" to tell them apart
3. **Regular Syncs**: Use 15-30 minute intervals to keep recent sessions backed up
4. **Test First**: Run "Test Connection" after setup to verify everything works
5. **Token Security**: Treat your GitHub token like a password - regenerate if compromised

## 🔐 Security Checklist

- [ ] Created PRIVATE repository
- [ ] Set token to "repo" scope only
- [ ] Tested connection successfully
- [ ] Token is not shared anywhere
- [ ] Browser profile name is set

## ❓ FAQ

**Q: Is my data visible to GitHub?**
A: No. Your session data is stored in your private repository, encrypted with Base64. Only you can access it.

**Q: What if I forget my token?**
A: Generate a new one in GitHub Settings, update the extension settings.

**Q: Can I sync across browsers?**
A: Yes! Each browser gets a unique ID. Restore any session on any browser.

**Q: Does it work offline?**
A: No, syncing requires internet connection to GitHub.

**Q: How many sessions can I store?**
A: As many as fit in your GitHub repo (typically hundreds of sessions).

---

**Ready to start?** → Click the extension icon and hit "💾 Sync Now" to save your first session!
