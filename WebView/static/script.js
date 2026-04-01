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

    // Init
    init();

    async function init() {
        setupEventListeners();
        await loadSessions();
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
            syncBtn.textContent = 'Syncing...';
            try {
                const response = await fetch('/api/sync');
                const data = await response.json();
                if (data.status === 'success') {
                    await loadSessions();
                    renderTimeline();
                    alert(`Sync complete! Loaded ${data.count} sessions.`);
                }
            } catch (error) {
                console.error('Sync failed:', error);
            } finally {
                syncBtn.disabled = false;
                syncBtn.textContent = 'Sync from GitHub';
            }
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

    function renderTimeline() {
        timelineList.className = `timeline-container ${currentStyle}-view`;
        timelineList.innerHTML = '';

        if (sessions.length === 0) {
            timelineList.innerHTML = '<div class="no-data">No sessions found. Sync from GitHub to begin.</div>';
            return;
        }

        sessions.forEach(session => {
            const card = document.createElement('div');
            card.className = 'session-card';
            
            const content = JSON.parse(session.content);
            const date = new Date(session.timestamp).toLocaleString();
            const tabCount = session.tab_count || 0;
            const kindClass = `kind-${session.kind.toLowerCase()}`;
            
            // Get first 3 tabs for preview
            const allTabs = content.windows.flatMap(w => w.tabs);
            const previewTabs = allTabs.slice(0, 3).map(t => `<span class="tab-badge">${t.title}</span>`).join('');

            card.innerHTML = `
                <div class="session-info">
                    <div class="session-meta">
                        <span class="kind-pill ${kindClass}">${session.kind}</span>
                        <span>${date}</span>
                        <span>${session.browser_alias || 'Unknown Browser'}</span>
                        <span>${tabCount} tabs</span>
                    </div>
                    <div class="session-title">${content.friendlyName || 'Session Backup'}</div>
                    <div class="tab-badges">${previewTabs} ${allTabs.length > 3 ? '<span class="tab-badge">...</span>' : ''}</div>
                </div>
            `;

            card.addEventListener('click', () => showSessionDetails(content));
            timelineList.appendChild(card);
        });
    }

    function showSessionDetails(session) {
        modalBody.innerHTML = `
            <div class="modal-header">
                <h2>${session.friendlyName || 'Browsing Session'}</h2>
                <p>${new Date(session.timestamp).toLocaleString()} • ${session.browserAlias}</p>
            </div>
            <div class="modal-tabs-list">
                ${session.windows.map((win, idx) => `
                    <div class="window-group">
                        <h3>Window ${idx + 1} (${win.tabs.length} tabs)</h3>
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
        modal.style.display = 'block';
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
});
