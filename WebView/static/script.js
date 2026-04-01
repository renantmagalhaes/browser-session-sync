document.addEventListener('DOMContentLoaded', () => {
    let sessions = [];
    let currentView = 'timeline';
    let currentStyle = localStorage.getItem('timelineStyle') || 'list';

    // UI Elements
    const timelineList = document.getElementById('timelineList');
    const syncBtn = document.getElementById('syncBtn');
    const navBtn = document.querySelectorAll('.nav-btn');
    const viewBtn = document.querySelectorAll('.view-btn');
    const modal = document.getElementById('sessionModal');
    const modalBody = document.getElementById('modalBody');
    const closeModal = document.querySelector('.close-modal');
    const searchInput = document.getElementById('searchInput');
    const profileDropdown = document.getElementById('profileDropdown');
    const searchCount = document.getElementById('searchCount');

    let activeProfile = 'all';
    let searchQuery = '';

    // Init
    init();

    async function init() {
        setupEventListeners();
        await Promise.all([loadSessions(), loadProfiles()]);
        renderTimeline();
    }

    function setupEventListeners() {
        // Navigation (Timeline vs Graph)
        navBtn.forEach(btn => {
            btn.addEventListener('click', () => {
                navBtn.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentView = btn.dataset.view;
                
                document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));
                document.getElementById(`${currentView}View`).classList.add('active');
                
                if (currentView === 'graph') {
                    renderGraph();
                } else if (currentView === 'settings') {
                    loadSettings();
                }
            });
        });

        // Timeline Styles (List, Grid, Compact)
        viewBtn.forEach(btn => {
            btn.addEventListener('click', () => {
                viewBtn.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentStyle = btn.dataset.style;
                localStorage.setItem('timelineStyle', currentStyle);
                renderTimeline();
            });
            if (btn.dataset.style === currentStyle) btn.classList.add('active');
        });

        // Sync Trigger
        syncBtn.addEventListener('click', async () => {
            syncBtn.disabled = true;
            syncBtn.classList.add('loading');
            syncBtn.textContent = 'Syncing...';
            try {
                const response = await fetch('/api/sync');
                const data = await response.json();
                if (data.status === 'success') {
                    await Promise.all([loadSessions(), loadProfiles()]);
                    renderTimeline();
                    // Subtle notification instead of alert
                    statusToast(`Synced ${data.count} sessions`);
                }
            } catch (error) {
                console.error('Sync failed:', error);
                statusToast('Sync failed', 'error');
            } finally {
                syncBtn.disabled = false;
                syncBtn.classList.remove('loading');
                syncBtn.textContent = 'Sync from GitHub';
            }
        });

        // Search Input
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.toLowerCase();
            renderTimeline();
        });

        // Profile Selection dropdown
        profileDropdown.addEventListener('change', (e) => {
            activeProfile = e.target.value;
            renderTimeline();
        });

        // Modal close
        closeModal.onclick = () => modal.style.display = 'none';
        window.onclick = (e) => { if (e.target == modal) modal.style.display = 'none'; };
    }

    async function loadSessions() {
        try {
            const response = await fetch('/api/sessions');
            sessions = await response.json();
        } catch (error) {
            console.error('Failed to load sessions:', error);
        }
    }

    async function loadProfiles() {
        try {
            const response = await fetch('/api/profiles');
            const profiles = await response.json();
            
            profileDropdown.innerHTML = '<option value="all">All Profiles</option>' + 
                profiles.map(p => `<option value="${p}">${p}</option>`).join('');
            
            profileDropdown.value = activeProfile;
        } catch (error) {
            console.error('Failed to load profiles:', error);
        }
    }

    function statusToast(msg, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `status-toast ${type}`;
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    function renderTimeline() {
        timelineList.className = `timeline-container ${currentStyle}-view`;
        timelineList.innerHTML = '';

        const filtered = sessions.filter(s => {
            const matchesProfile = activeProfile === 'all' || s.browser_alias === activeProfile;
            const matchesSearch = !searchQuery || s.search_text?.toLowerCase().includes(searchQuery);
            return matchesProfile && matchesSearch;
        });

        searchCount.textContent = searchQuery || activeProfile !== 'all' ? `${filtered.length} matches` : '';

        if (filtered.length === 0) {
            timelineList.innerHTML = '<div class="no-data">No sessions match your filters.</div>';
            return;
        }

        filtered.forEach((session, index) => {
            const card = document.createElement('div');
            card.className = `session-card ${session.is_pinned ? 'pinned' : ''}`;
            card.style.animationDelay = `${index * 0.05}s`;
            
            const date = new Date(session.timestamp).toLocaleString();
            const tabCount = session.tab_count || 0;
            const kindClass = `kind-${session.kind.toLowerCase()}`;
            
            // Use metadata from DB
            const previewData = JSON.parse(session.preview_tabs || '[]');
            const previewHtml = previewData.map(t => `<span class="tab-badge">${t.title}</span>`).join('');
            
            const title = session.friendly_name || 
                        (session.kind === 'timeline' ? 'Timeline Update' : 'Session Backup');

            card.innerHTML = `
                <div class="session-info">
                    <div class="session-meta">
                        <span class="kind-pill ${kindClass}">${session.kind}</span>
                        ${session.is_pinned ? '<span class="pin-icon">📌</span>' : ''}
                        <span>${date}</span>
                        <span>${session.browser_alias || 'Default Browser'}</span>
                        <span>${tabCount} tabs</span>
                    </div>
                    <div class="session-title">${title}</div>
                    <div class="tab-badges">${previewHtml} ${tabCount > previewData.length ? '<span class="tab-badge">...</span>' : ''}</div>
                </div>
            `;

            card.addEventListener('click', () => showSessionDetails(session));
            timelineList.appendChild(card);
        });
    }

    async function showSessionDetails(sessionSummary) {
        // Show loading state in modal
        modalBody.innerHTML = '<div class="loading-shimmer-modal"></div>';
        modal.style.display = 'block';

        try {
            const response = await fetch(`/api/session/details?path=${encodeURIComponent(sessionSummary.path)}`);
            const session = await response.json();
            
            modalBody.innerHTML = `
                <div class="modal-header">
                    <h2>${session.friendlyName || 'Browsing Session'}</h2>
                    <p>${new Date(session.timestamp).toLocaleString()} • ${session.browserAlias}</p>
                </div>
                <div class="modal-tabs-list">
                    ${session.windows.map((win, idx) => `
                        <div class="window-group">
                            <h3 class="window-title">Window ${idx + 1} <span>${win.tabs.length} tabs</span></h3>
                            <ul class="tabs-list">
                                ${win.tabs.map(tab => `
                                    <li>
                                        <a href="${tab.url}" target="_blank">
                                            <span class="tab-title">${tab.title}</span>
                                            <span class="tab-url">${tab.url}</span>
                                        </a>
                                    </li>
                                `).join('')}
                            </ul>
                        </div>
                    `).join('')}
                </div>
            `;
        } catch (error) {
            modalBody.innerHTML = '<div class="error-msg">Failed to load session details.</div>';
        }
    }

    async function renderGraph() {
        const container = document.getElementById('graphContainer');
        container.innerHTML = ''; // Clear previous
        
        try {
            const response = await fetch('/api/graph');
            const data = await response.json();
            
            if (!data.nodes.length) {
                container.innerHTML = '<div class="no-data">Not enough data for graph.</div>';
                return;
            }

            const width = container.clientWidth;
            const height = container.clientHeight;

            const svg = d3.select("#graphContainer")
                .append("svg")
                .attr("width", width)
                .attr("height", height)
                .call(d3.zoom().on("zoom", function (event) {
                    g.attr("transform", event.transform);
                }))
                .append("g");

            const g = svg.append("g");

            const simulation = d3.forceSimulation(data.nodes)
                .force("link", d3.forceLink(data.links).id(d => d.id).distance(100))
                .force("charge", d3.forceManyBody().strength(-200))
                .force("center", d3.forceCenter(width / 2, height / 2));

            const link = g.append("g")
                .attr("stroke", "rgba(255,255,255,0.1)")
                .attr("stroke-opacity", 0.6)
                .selectAll("line")
                .data(data.links)
                .join("line")
                .attr("stroke-width", d => Math.sqrt(d.weight) * 2);

            const node = g.append("g")
                .attr("stroke", "#fff")
                .attr("stroke-width", 1.5)
                .selectAll("g")
                .data(data.nodes)
                .join("g")
                .call(drag(simulation));

            node.append("circle")
                .attr("r", d => 5 + Math.sqrt(d.value) * 2)
                .attr("fill", d => d3.interpolateTurbo(Math.random())); // Vibrant randomness

            node.append("text")
                .text(d => d.id)
                .attr("x", 8)
                .attr("y", 3)
                .attr("fill", "#94a3b8")
                .attr("font-size", "10px")
                .attr("pointer-events", "none");

            simulation.on("tick", () => {
                link
                    .attr("x1", d => d.source.x)
                    .attr("y1", d => d.source.y)
                    .attr("x2", d => d.target.x)
                    .attr("y2", d => d.target.y);

                node
                    .attr("transform", d => `translate(${d.x},${d.y})`);
            });

            function drag(simulation) {
                function dragstarted(event) {
                    if (!event.active) simulation.alphaTarget(0.3).restart();
                    event.subject.fx = event.subject.x;
                    event.subject.fy = event.subject.y;
                }
                function dragged(event) {
                    event.subject.fx = event.x;
                    event.subject.fy = event.y;
                }
                function dragended(event) {
                    if (!event.active) simulation.alphaTarget(0);
                    event.subject.fx = null;
                    event.subject.fy = null;
                }
                return d3.drag()
                    .on("start", dragstarted)
                    .on("drag", dragged)
                    .on("end", dragended);
            }
        } catch (error) {
            console.error('Graph build failed:', error);
        }
    }

    async function loadSettings() {
        const status = document.getElementById('settingsStatus');
        try {
            const response = await fetch('/api/settings');
            const data = await response.json();
            
            document.getElementById('setting_username').value = data.GITHUB_USERNAME || '';
            document.getElementById('setting_repo').value = data.GITHUB_REPO || '';
            document.getElementById('setting_token').placeholder = data.HAS_TOKEN ? '•••••••• (Token saved)' : 'Enter GitHub Token';
        } catch (error) {
            console.error('Failed to load settings:', error);
        }
    }

    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = document.getElementById('settingsStatus');
        status.textContent = 'Saving...';
        status.className = 'status-msg';

        const payload = {
            GITHUB_USERNAME: document.getElementById('setting_username').value,
            GITHUB_REPO: document.getElementById('setting_repo').value,
            GITHUB_TOKEN: document.getElementById('setting_token').value,
            WEBVIEW_PASSWORD: document.getElementById('setting_password').value
        };

        try {
            const response = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            if (response.ok) {
                status.textContent = 'Settings saved successfully!';
                status.classList.add('success');
                document.getElementById('setting_token').value = '';
                document.getElementById('setting_password').value = '';
                await loadSettings();
            } else {
                status.textContent = 'Failed to save settings.';
                status.classList.add('error');
            }
        } catch (error) {
            status.textContent = 'Error saving settings.';
            status.classList.add('error');
        }
    });
});
