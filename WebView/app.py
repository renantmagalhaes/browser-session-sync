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
                content TEXT
            )
        """)
        db.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON sessions(timestamp)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_kind ON sessions(kind)")
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
    def __init__(self):
        self.base_url = f"https://api.github.com/repos/{settings.GITHUB_USERNAME}/{settings.GITHUB_REPO}"
        self.headers = {
            "Authorization": f"token {settings.GITHUB_TOKEN}",
            "Accept": "application/vnd.github.v3+json"
        }

    def fetch_index(self):
        response = requests.get(f"{self.base_url}/contents/sessions/index.json", headers=self.headers)
        if response.status_code == 200:
            content = base64.b64decode(response.json()["content"]).decode("utf-8")
            return json.loads(content)
        return {"sessions": []}

    def fetch_session(self, path: str):
        response = requests.get(f"{self.base_url}/contents/{path}", headers=self.headers)
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
        sessions = index_data.get("sessions", [])
        
        with get_db() as db:
            for s in sessions:
                # Check if we have this session and it's the same SHA
                cursor = db.execute("SELECT sha FROM sessions WHERE path = ?", (s["path"],))
                row = cursor.fetchone()
                
                if not row or row["sha"] != s.get("sha"):
                    # Fetch full session data
                    full_data = gh_client.fetch_session(s["path"])
                    if full_data:
                        db.execute("""
                            INSERT OR REPLACE INTO sessions 
                            (path, sha, timestamp, client_id, profile_key, browser_alias, kind, tab_count, content)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, (
                            s["path"], s.get("sha"), s["timestamp"], s.get("clientId"), 
                            s.get("profileKey"), s.get("browserAlias"), s.get("kind", "history"),
                            s.get("tabCount", 0), json.dumps(full_data)
                        ))
            db.commit()
        return {"status": "success", "count": len(sessions)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

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
        cursor = db.execute("SELECT content FROM sessions ORDER BY timestamp DESC LIMIT 50")
        rows = cursor.fetchall()
        
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
