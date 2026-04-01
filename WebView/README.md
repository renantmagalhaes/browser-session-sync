# Browser Session Sync - WebView

A modern, dark-themed dashboard to visualize your browser sessions synced to GitHub. Features a detailed timeline, multi-view layouts, and an Obsidian-style relationship graph.

## Features

- **Detailed Timeline**: Browse your history in List, Grid, or Compact modes.
- **Graph Explorer**: Obsidian-style force-directed graph showing correlations between domains you visit together.
- **Quick Sync**: One-click synchronization from your GitHub repository.
- **Secure**: Basic authentication layer to protect your data.
- **Fast**: Local SQLite caching for near-instant interaction.

## Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose installed.
- A GitHub Personal Access Token (PAT) with `repo` scope.

## Quick Start

1. **Configure Credentials**:
   Edit `WebView/app.py` or create a `.env` file in the `WebView` directory with the following:
   ```env
   GITHUB_USERNAME=your-username
   GITHUB_TOKEN=your-github-token
   GITHUB_REPO=your-repo-name
   WEBVIEW_PASSWORD=your-secret-password
   ```

2. **Run with Docker**:
   From the root of the repository:
   ```bash
   cd WebView
   docker compose up -d --build
   ```

3. **Access the Dashboard**:
   Open [http://localhost:8000](http://localhost:8000) in your browser and log in with your `WEBVIEW_PASSWORD`.

## Volume Persistence

The application uses a Docker volume to persist the SQLite database and session cache. This ensures fast performance even after container restarts. By default, it maps a local `./data` folder to `/data` in the container.

## Development

To run locally without Docker:
```bash
cd WebView
pip install -r requirements.txt
python app.py
```
