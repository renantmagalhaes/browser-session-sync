import os
import sqlite3
import json
import base64
import requests
from datetime import datetime
from typing import List, Optional
from fastapi import FastAPI, Request, Depends, HTTPException, status, Form
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic_settings import BaseSettings
from passlib.context import CryptContext
from jose import JWTError, jwt

# Configuration
class Settings(BaseSettings):
    # GitHub Credentials - Replace with your own or use ENV vars
    GITHUB_USERNAME: str = "your-github-username"
    GITHUB_TOKEN: str = "your-github-token"
    GITHUB_REPO: str = "your-repo-name"
    
    # WebView Security
    WEBVIEW_PASSWORD: str = "admin123" # Change this!
    SECRET_KEY: str = "a-very-secret-key-for-jwt"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 # 1 day

    # Storage
    DATA_DB_PATH: str = "data/cache.db"
    SESSION_CACHE_DIR: str = "data/sessions"

    class Config:
        env_file = ".env"

settings = Settings()
os.makedirs(os.path.dirname(settings.DATA_DB_PATH), exist_ok=True)
os.makedirs(settings.SESSION_CACHE_DIR, exist_ok=True)

# Database Setup
def get_db():
    db = sqlite3.connect(settings.DATA_DB_PATH)
    db.row_factory = sqlite3.Row
    return db

def init_db():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                path TEXT PRIMARY KEY,
                sha TEXT,
                timestamp TEXT,
                client_id TEXT,
                profile_key TEXT,
                browser_alias TEXT,
                kind TEXT,
                tab_count INTEGER,
                search_text TEXT,
                preview_tabs TEXT,
                friendly_name TEXT,
                is_pinned INTEGER DEFAULT 0,
                content TEXT
            )
        """)
        db.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON sessions(timestamp)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_kind ON sessions(kind)")
        
        # Schema Migration: Add missing columns if they don't exist
        cursor = db.execute("PRAGMA table_info(sessions)")
        columns = [row["name"] for row in cursor.fetchall()]
        if "friendly_name" not in columns:
            db.execute("ALTER TABLE sessions ADD COLUMN friendly_name TEXT")
        if "is_pinned" not in columns:
            db.execute("ALTER TABLE sessions ADD COLUMN is_pinned INTEGER DEFAULT 0")
        if "search_text" not in columns:
            db.execute("ALTER TABLE sessions ADD COLUMN search_text TEXT")
        if "preview_tabs" not in columns:
            db.execute("ALTER TABLE sessions ADD COLUMN preview_tabs TEXT")
            
        db.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        db.commit()

def get_setting(key: str, default: str = None):
    with get_db() as db:
        cursor = db.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = cursor.fetchone()
        return row["value"] if row else default

def set_setting(key: str, value: str):
    with get_db() as db:
        db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
        db.commit()

init_db()

# App Setup
app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Auth Helpers
def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password):
    return pwd_context.hash(password)

def create_access_token(data: dict):
    to_encode = data.copy()
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)

async def get_current_user(request: Request):
    token = request.cookies.get("access_token")
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        return payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

# GitHub Client
class GitHubClient:
    def get_config(self):
        return {
            "username": get_setting("GITHUB_USERNAME", settings.GITHUB_USERNAME),
            "token": get_setting("GITHUB_TOKEN", settings.GITHUB_TOKEN),
            "repo": get_setting("GITHUB_REPO", settings.GITHUB_REPO)
        }

    def fetch_index(self):
        cfg = self.get_config()
        base_url = f"https://api.github.com/repos/{cfg['username']}/{cfg['repo']}"
        headers = {
            "Authorization": f"token {cfg['token']}",
            "Accept": "application/vnd.github.v3+json"
        }
        response = requests.get(f"{base_url}/contents/sessions/index.json", headers=headers)
        if response.status_code == 200:
            content = base64.b64decode(response.json()["content"]).decode("utf-8")
            return json.loads(content)
        return {"sessions": []}

    def fetch_session(self, path: str):
        cfg = self.get_config()
        base_url = f"https://api.github.com/repos/{cfg['username']}/{cfg['repo']}"
        headers = {
            "Authorization": f"token {cfg['token']}",
            "Accept": "application/vnd.github.v3+json"
        }
        response = requests.get(f"{base_url}/contents/{path}", headers=headers)
        if response.status_code == 200:
            content = base64.b64decode(response.json()["content"]).decode("utf-8")
            return json.loads(content)
        return None

gh_client = GitHubClient()

# Routes
@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})

@app.post("/login")
async def login(password: str = Form(...)):
    if password == settings.WEBVIEW_PASSWORD:
        token = create_access_token({"sub": "admin"})
        response = RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)
        response.set_cookie(key="access_token", value=token, httponly=True)
        return response
    return RedirectResponse(url="/login?error=1", status_code=status.HTTP_303_SEE_OTHER)

@app.get("/logout")
async def logout():
    response = RedirectResponse(url="/login")
    response.delete_cookie("access_token")
    return response

@app.get("/", response_class=HTMLResponse)
async def index(request: Request, user: str = Depends(get_current_user)):
    return templates.TemplateResponse("index.html", {"request": request, "user": user})

@app.get("/api/sync")
async def sync_data(user: str = Depends(get_current_user)):
    try:
        index_data = gh_client.fetch_index()
        sessions_metadata = index_data.get("sessions", [])
        
        with get_db() as db:
            for s in sessions_metadata:
                preview_tabs = json.dumps(s.get("previewTabs", []))
                # Update metadata (Fast!)
                db.execute("""
                    INSERT INTO sessions 
                    (path, sha, timestamp, client_id, profile_key, browser_alias, kind, tab_count, search_text, preview_tabs, friendly_name, is_pinned)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(path) DO UPDATE SET
                        sha = excluded.sha,
                        timestamp = excluded.timestamp,
                        kind = excluded.kind,
                        tab_count = excluded.tab_count,
                        search_text = excluded.search_text,
                        preview_tabs = excluded.preview_tabs,
                        browser_alias = excluded.browser_alias,
                        friendly_name = excluded.friendly_name,
                        is_pinned = excluded.is_pinned
                """, (
                    s["path"], s.get("sha"), s["timestamp"], s.get("clientId"), 
                    s.get("profileKey", ""), s.get("browserAlias", "Default Browser"), s.get("kind", "history"),
                    s.get("tabCount", 0), s.get("searchText", ""), preview_tabs,
                    s.get("friendlyName", ""), 1 if s.get("pinned") else 0
                ))
            
            # Hybrid Sync: Fetch contents for the top 20 most recent entries to power the Graph/Search
            recent_missing = db.execute("""
                SELECT path FROM sessions 
                WHERE content IS NULL 
                ORDER BY timestamp DESC LIMIT 20
            """).fetchall()
            
            for row in recent_missing:
                path = row["path"]
                try:
                    full_data = gh_client.fetch_session(path)
                    if full_data:
                        db.execute("UPDATE sessions SET content = ? WHERE path = ?", (json.dumps(full_data), path))
                except Exception:
                    continue 

            db.commit()
        return {"status": "success", "count": len(sessions_metadata)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.get("/api/session/details")
async def get_session_details(path: str, user: str = Depends(get_current_user)):
    with get_db() as db:
        cursor = db.execute("SELECT content FROM sessions WHERE path = ?", (path,))
        row = cursor.fetchone()
        
        if row and row["content"]:
            return json.loads(row["content"])
            
        # Fetch from GitHub if missing
        full_data = gh_client.fetch_session(path)
        if full_data:
            db.execute("UPDATE sessions SET content = ? WHERE path = ?", (json.dumps(full_data), path))
            db.commit()
            return full_data
            
    raise HTTPException(status_code=404, detail="Session details not found")

@app.get("/api/profiles")
async def get_profiles(user: str = Depends(get_current_user)):
    with get_db() as db:
        cursor = db.execute("SELECT DISTINCT browser_alias FROM sessions WHERE browser_alias IS NOT NULL ORDER BY browser_alias")
        return [row["browser_alias"] for row in cursor.fetchall()]

@app.get("/api/sessions")
async def get_sessions(kind: Optional[str] = None, user: str = Depends(get_current_user)):
    with get_db() as db:
        query = "SELECT * FROM sessions"
        params = []
        if kind:
            query += " WHERE kind = ?"
            params.append(kind)
        query += " ORDER BY timestamp DESC"
        cursor = db.execute(query, params)
        rows = cursor.fetchall()
        return [dict(row) for row in rows]

@app.get("/api/graph")
async def get_graph_data(user: str = Depends(get_current_user)):
    # Simple Obsidian-style graph logic
    # Nodes: Domains
    # Links: If two domains appear in the same session
    from urllib.parse import urlparse
    
    nodes = {}
    edges = {}
    
    with get_db() as db:
        cursor = db.execute("SELECT content FROM sessions WHERE content IS NOT NULL ORDER BY timestamp DESC LIMIT 30")
        rows = cursor.fetchall()
        
        if not rows:
            return {"nodes": [], "links": []}
        
        for row in rows:
            session = json.loads(row["content"])
            session_domains = set()
            for window in session.get("windows", []):
                for tab in window.get("tabs", []):
                    domain = urlparse(tab["url"]).netloc
                    if domain:
                        session_domains.add(domain)
            
            # Add domains as nodes
            for domain in session_domains:
                nodes[domain] = nodes.get(domain, 0) + 1
            
            # Add relationships
            domain_list = list(session_domains)
            for i in range(len(domain_list)):
                for j in range(i + 1, len(domain_list)):
                    pair = tuple(sorted([domain_list[i], domain_list[j]]))
                    edges[pair] = edges.get(pair, 0) + 1

    return {
        "nodes": [{"id": d, "value": v} for d, v in nodes.items()],
        "links": [{"source": p[0], "target": p[1], "weight": w} for p, w in edges.items()]
    }

@app.get("/api/settings")
async def get_settings_api(user: str = Depends(get_current_user)):
    return {
        "GITHUB_USERNAME": get_setting("GITHUB_USERNAME", settings.GITHUB_USERNAME),
        "GITHUB_REPO": get_setting("GITHUB_REPO", settings.GITHUB_REPO),
        "HAS_TOKEN": bool(get_setting("GITHUB_TOKEN", settings.GITHUB_TOKEN))
    }

@app.post("/api/settings")
async def update_settings_api(request: Request, user: str = Depends(get_current_user)):
    data = await request.json()
    if "GITHUB_USERNAME" in data: set_setting("GITHUB_USERNAME", data["GITHUB_USERNAME"])
    if "GITHUB_REPO" in data: set_setting("GITHUB_REPO", data["GITHUB_REPO"])
    if "GITHUB_TOKEN" in data and data["GITHUB_TOKEN"]: 
        set_setting("GITHUB_TOKEN", data["GITHUB_TOKEN"])
    
    if "WEBVIEW_PASSWORD" in data and data["WEBVIEW_PASSWORD"]:
        # In a real app we'd hash this, but per settings we use plain for simplicity/ENV override
        # For now we'll just update the session setting to allow override
        set_setting("WEBVIEW_PASSWORD", data["WEBVIEW_PASSWORD"])
        
    return {"status": "success"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
