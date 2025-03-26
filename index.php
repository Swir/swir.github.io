<!DOCTYPE html>
<html lang="pl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Swir GitHub - Windows 3.11 Dark</title>
    <!-- Font Awesome -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        /* --- Zmienne CSS --- */
        :root {
            /* Paleta Windows 3.11 w wersji ciemnej */
            --win-bg: #000000;
            --win-dark-gray: #222222;
            --win-gray: #444444;
            --win-light-gray: #666666;
            --win-blue: #000080;
            --win-dark-blue: #000050;
            --win-text: #cccccc;
            --win-title-text: #ffffff;
            --win-highlight: #0000ff;
            --win-border-shadow: #111111;
            --win-border-light: #777777;
            --win-inactive: #444444;
            --win-inactive-text: #888888;
            --win-button: #444444;
            --win-button-text: #cccccc;
            --win-button-shadow: #111111;
            --win-button-highlight: #777777;
        }
        
        /* --- Reset i podstawowe style --- */
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'MS Sans Serif', 'Segoe UI', Tahoma, sans-serif;
        }
        
        html, body {
            background-color: var(--win-bg);
            color: var(--win-text);
            font-size: 12px;
            line-height: 1.4;
            overflow-x: hidden;
        }
        
        body {
            padding: 20px;
            min-height: 100vh;
        }

        /* --- Styl Windows 3.11 --- */
        .win-window {
            border: 2px solid var(--win-gray);
            background-color: var(--win-dark-gray);
            box-shadow: inset 1px 1px 0 var(--win-border-light), 
                        inset -1px -1px 0 var(--win-border-shadow);
            margin-bottom: 20px;
        }
        
        .win-title-bar {
            background-color: var(--win-blue);
            color: var(--win-title-text);
            padding: 2px 4px;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin: 2px;
        }
        
        .win-title {
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-size: 14px;
        }
        
        .win-buttons {
            display: flex;
        }
        
        .win-button {
            width: 16px;
            height: 16px;
            border: 1px solid var(--win-gray);
            background-color: var(--win-button);
            color: var(--win-button-text);
            margin-left: 2px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 9px;
            box-shadow: inset 1px 1px 0 var(--win-button-highlight), 
                        inset -1px -1px 0 var(--win-button-shadow);
            cursor: pointer;
        }
        
        .win-content {
            padding: 8px;
            margin: 2px;
            background-color: var(--win-dark-gray);
            overflow: auto;
            max-height: calc(100vh - 150px);
        }
        
        .win-status-bar {
            border-top: 1px solid var(--win-gray);
            padding: 4px 8px;
            font-size: 11px;
            color: var(--win-inactive-text);
            display: flex;
            justify-content: space-between;
            margin: 2px;
        }
        
        /* --- Menu w stylu Windows 3.11 --- */
        .win-menu-bar {
            background-color: var(--win-gray);
            padding: 2px 0;
            margin: 0 2px;
            display: flex;
        }
        
        .win-menu-item {
            padding: 1px 10px;
            margin-right: 2px;
            color: var(--win-text);
            cursor: pointer;
        }
        
        .win-menu-item:hover {
            background-color: var(--win-blue);
            color: var(--win-title-text);
        }
        
        /* --- Siatka ikon/repozytoriów --- */
        .win-repo-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
            gap: 16px;
            margin-top: 8px;
        }
        
        .win-repo-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            cursor: pointer;
            padding: 8px;
            border: 1px dotted transparent;
            transition: border-color 0.2s;
        }
        
        .win-repo-item:hover {
            border-color: var(--win-highlight);
            background-color: var(--win-dark-blue);
        }
        
        .win-repo-icon {
            width: 32px;
            height: 32px;
            background-color: var(--win-button);
            border: 1px solid var(--win-button-shadow);
            box-shadow: inset 1px 1px 0 var(--win-button-highlight), 
                        inset -1px -1px 0 var(--win-button-shadow);
            margin-bottom: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--win-button-text);
        }
        
        .win-repo-name {
            text-align: center;
            word-break: break-word;
            max-width: 100%;
            font-size: 11px;
            color: var(--win-text);
        }
        
        /* --- Modal okno szczegółów repozytorium --- */
        .win-modal {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 90%;
            max-width: 500px;
            z-index: 1000;
            display: none;
        }
        
        .win-modal-background {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.7);
            z-index: 999;
            display: none;
        }
        
        .win-repo-details {
            padding: 10px;
        }
        
        .win-repo-details-row {
            display: flex;
            margin-bottom: 8px;
            border-bottom: 1px solid var(--win-gray);
            padding-bottom: 8px;
        }
        
        .win-repo-details-label {
            width: 120px;
            font-weight: bold;
            color: var(--win-inactive-text);
        }
        
        .win-repo-details-value {
            flex: 1;
        }
        
        .win-repo-description {
            margin-bottom: 12px;
            padding: 8px;
            background-color: var(--win-gray);
            border: 1px solid var(--win-border-shadow);
            box-shadow: inset 1px 1px 0 var(--win-border-shadow);
        }
        
        .win-button-row {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 16px;
        }
        
        .win-action-button {
            padding: 4px 12px;
            background-color: var(--win-button);
            color: var(--win-button-text);
            border: 2px solid var(--win-gray);
            box-shadow: inset 1px 1px 0 var(--win-button-highlight), 
                        inset -1px -1px 0 var(--win-button-shadow);
            cursor: pointer;
            min-width: 80px;
            text-align: center;
        }
        
        .win-action-button:active {
            box-shadow: inset -1px -1px 0 var(--win-button-highlight), 
                        inset 1px 1px 0 var(--win-button-shadow);
        }
        
        /* --- Łądowanie --- */
        .win-loading {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 200px;
        }
        
        .win-loading-text {
            margin-bottom: 16px;
            font-weight: bold;
        }
        
        .win-loading-animation {
            width: 120px;
            height: 20px;
            background-color: var(--win-gray);
            border: 1px solid var(--win-border-shadow);
            padding: 2px;
            position: relative;
            box-shadow: inset 1px 1px 0 var(--win-border-shadow);
        }
        
        .win-loading-bar {
            height: 100%;
            background-color: var(--win-blue);
            width: 20%;
            animation: win-loading 2s infinite;
        }
        
        @keyframes win-loading {
            0% { width: 0; }
            25% { width: 40%; }
            50% { width: 70%; }
            75% { width: 90%; }
            100% { width: 100%; }
        }
        
        /* --- Stare ikony Windows --- */
        @font-face {
            font-family: 'Webdings';
            src: url('https://cdn.jsdelivr.net/npm/webdings-font@1.0.0/webdings.woff') format('woff');
        }
        
        .webdings {
            font-family: 'Webdings', sans-serif;
        }
        
        /* --- Startup screen --- */
        .win-startup {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: var(--win-dark-blue);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            z-index: 2000;
            transition: opacity 0.5s, visibility 0.5s;
        }
        
        .win-startup.hidden {
            opacity: 0;
            visibility: hidden;
        }
        
        .win-logo {
            font-size: 72px;
            color: white;
            font-weight: bold;
            margin-bottom: 20px;
            text-align: center;
            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.5);
        }
        
        .win-startup-loading {
            width: 300px;
            height: 20px;
            background-color: var(--win-gray);
            border: 1px solid var(--win-border-light);
            padding: 2px;
            position: relative;
        }
        
        .win-startup-bar {
            height: 100%;
            background-color: var(--win-blue);
            width: 0%;
            animation: win-startup-loading 3s forwards;
        }
        
        @keyframes win-startup-loading {
            0% { width: 0; }
            70% { width: 70%; }
            100% { width: 100%; }
        }
        
        .win-startup-text {
            margin-top: 20px;
            color: white;
            font-size: 14px;
        }
        
        /* --- Error Window --- */
        .win-error {
            border: 2px solid var(--win-gray);
            background-color: var(--win-dark-gray);
            box-shadow: inset 1px 1px 0 var(--win-border-light), 
                        inset -1px -1px 0 var(--win-border-shadow);
            max-width: 400px;
            margin: 100px auto;
        }
        
        .win-error-title {
            background-color: #aa0000;
            color: white;
            padding: 2px 4px;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin: 2px;
        }
        
        .win-error-content {
            padding: 16px;
            display: flex;
            align-items: flex-start;
            gap: 12px;
        }
        
        .win-error-icon {
            font-size: 32px;
            color: #aa0000;
        }
        
        .win-error-message {
            flex: 1;
        }
        
        .win-error-buttons {
            display: flex;
            justify-content: center;
            margin-top: 20px;
            margin-bottom: 10px;
        }
        
        /* --- Responsywność --- */
        @media (max-width: 768px) {
            .win-repo-grid {
                grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
            }
            
            .win-modal {
                width: 95%;
            }
        }

        @media (max-width: 480px) {
            .win-repo-grid {
                grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
            }
        }
    </style>
</head>
<body>
    <!-- Ekran startowy Windows -->
    <div class="win-startup">
        <div class="win-logo">Windows 3.11</div>
        <div class="win-startup-loading">
            <div class="win-startup-bar"></div>
        </div>
        <div class="win-startup-text">Starting Program Manager...</div>
    </div>

    <!-- Główne okno aplikacji -->
    <div class="win-window">
        <div class="win-title-bar">
            <div class="win-title">Program Manager - Swir GitHub</div>
            <div class="win-buttons">
                <div class="win-button">_</div>
                <div class="win-button">□</div>
                <div class="win-button">×</div>
            </div>
        </div>
        
        <div class="win-menu-bar">
            <div class="win-menu-item">File</div>
            <div class="win-menu-item">Options</div>
            <div class="win-menu-item">Window</div>
            <div class="win-menu-item">Help</div>
        </div>
        
        <div class="win-content">
            <div id="repos-container">
                <!-- Tutaj będą wczytywane repozytoria -->
                <div class="win-loading">
                    <div class="win-loading-text">Loading repositories...</div>
                    <div class="win-loading-animation">
                        <div class="win-loading-bar"></div>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="win-status-bar">
            <div>6 object(s)</div>
            <div>1.44MB free</div>
        </div>
    </div>
    
    <!-- Modal okno ze szczegółami repozytorium -->
    <div class="win-modal" id="repo-details-modal">
        <div class="win-window">
            <div class="win-title-bar">
                <div class="win-title" id="modal-repo-name">Repository Properties</div>
                <div class="win-buttons">
                    <div class="win-button" onclick="closeRepoModal()">×</div>
                </div>
            </div>
            
            <div class="win-content win-repo-details" id="repo-details-content">
                <!-- Tu zostanie wstawiona zawartość modalu -->
            </div>
            
            <div class="win-status-bar">
                <div>GitHub Repository</div>
            </div>
        </div>
    </div>
    
    <div class="win-modal-background" id="modal-background" onclick="closeRepoModal()"></div>

    <script>
        // Zamknięcie ekranu startowego po załadowaniu
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => {
                document.querySelector('.win-startup').classList.add('hidden');
                
                // Wczytaj repozytoria
                fetchRepositories();
            }, 3000);
        });
        
        // Pobieranie listy repozytoriów
        async function fetchRepositories() {
            const username = 'Swir';
            const reposContainer = document.getElementById('repos-container');
            
            try {
                const response = await fetch(`https://api.github.com/users/${username}/repos?per_page=100`);
                
                if (!response.ok) {
                    throw new Error(`GitHub API responded with status: ${response.status}`);
                }
                
                const repos = await response.json();
                
                // Sortowanie repozytoriów
                repos.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
                
                if (repos.length === 0) {
                    showErrorWindow("No repositories found", "User has no public repositories available.");
                    return;
                }
                
                // Aktualizuj licznik repozytoriów
                document.querySelector('.win-status-bar div:first-child').textContent = `${repos.length} object(s)`;
                
                // Utwórz siatkę repozytoriów
                const repoGrid = document.createElement('div');
                repoGrid.className = 'win-repo-grid';
                
                // Dodaj każde repozytorium jako ikonę
                repos.forEach(repo => {
                    const repoItem = document.createElement('div');
                    repoItem.className = 'win-repo-item';
                    repoItem.onclick = () => showRepoDetails(repo);
                    
                    // Utwórz odpowiednią ikonę dla języka
                    let iconClass = 'fas fa-file-code';
                    if (repo.language) {
                        if (repo.language === 'JavaScript') iconClass = 'fab fa-js-square';
                        else if (repo.language === 'HTML') iconClass = 'fab fa-html5';
                        else if (repo.language === 'CSS') iconClass = 'fab fa-css3-alt';
                        else if (repo.language === 'Python') iconClass = 'fab fa-python';
                        else if (repo.language === 'Java') iconClass = 'fab fa-java';
                        else if (repo.language === 'PHP') iconClass = 'fab fa-php';
                    }
                    
                    repoItem.innerHTML = `
                        <div class="win-repo-icon">
                            <i class="${iconClass}"></i>
                        </div>
                        <div class="win-repo-name">${repo.name}</div>
                    `;
                    
                    repoGrid.appendChild(repoItem);
                });
                
                reposContainer.innerHTML = '';
                reposContainer.appendChild(repoGrid);
                
            } catch (error) {
                console.error('Error fetching repositories:', error);
                showErrorWindow("Connection Error", error.message);
            }
        }
        
        // Wyświetla szczegóły repozytorium w oknie modalnym
        function showRepoDetails(repo) {
            const modal = document.getElementById('repo-details-modal');
            const modalBg = document.getElementById('modal-background');
            const content = document.getElementById('repo-details-content');
            const modalTitle = document.getElementById('modal-repo-name');
            
            // Ustaw tytuł
            modalTitle.textContent = repo.name;
            
            // Formatuj datę
            const createdDate = new Date(repo.created_at).toLocaleDateString();
            const updatedDate = new Date(repo.updated_at).toLocaleDateString();
            
            // Przygotuj zawartość
            content.innerHTML = `
                <div class="win-repo-description">
                    ${repo.description || "No description available."}
                </div>
                
                <div class="win-repo-details-row">
                    <div class="win-repo-details-label">Created:</div>
                    <div class="win-repo-details-value">${createdDate}</div>
                </div>
                
                <div class="win-repo-details-row">
                    <div class="win-repo-details-label">Last Updated:</div>
                    <div class="win-repo-details-value">${updatedDate}</div>
                </div>
                
                <div class="win-repo-details-row">
                    <div class="win-repo-details-label">Language:</div>
                    <div class="win-repo-details-value">${repo.language || "Not specified"}</div>
                </div>
                
                <div class="win-repo-details-row">
                    <div class="win-repo-details-label">Stars:</div>
                    <div class="win-repo-details-value">${repo.stargazers_count}</div>
                </div>
                
                <div class="win-repo-details-row">
                    <div class="win-repo-details-label">Forks:</div>
                    <div class="win-repo-details-value">${repo.forks_count}</div>
                </div>
                
                <div class="win-repo-details-row">
                    <div class="win-repo-details-label">Watchers:</div>
                    <div class="win-repo-details-value">${repo.watchers_count}</div>
                </div>
                
                <div class="win-repo-details-row">
                    <div class="win-repo-details-label">Size:</div>
                    <div class="win-repo-details-value">${repo.size} KB</div>
                </div>
                
                <div class="win-button-row">
                    <a href="${repo.html_url}" target="_blank" class="win-action-button">Open</a>
                    <button class="win-action-button" onclick="closeRepoModal()">Cancel</button>
                </div>
            `;
            
            // Pokaż modal
            modal.style.display = 'block';
            modalBg.style.display = 'block';
        }
        
        // Zamyka modal
        function closeRepoModal() {
            document.getElementById('repo-details-modal').style.display = 'none';
            document.getElementById('modal-background').style.display = 'none';
        }
        
        // Pokaż okno błędu
        function showErrorWindow(title, message) {
            const reposContainer = document.getElementById('repos-container');
            
            reposContainer.innerHTML = `
                <div class="win-error">
                    <div class="win-error-title">
                        <div>${title}</div>
                        <div class="win-buttons">
                            <div class="win-button" onclick="location.reload()">×</div>
                        </div>
                    </div>
                    <div class="win-error-content">
                        <div class="win-error-icon">×</div>
                        <div class="win-error-message">${message}</div>
                    </div>
                    <div class="win-error-buttons">
                        <button class="win-action-button" onclick="location.reload()">OK</button>
                    </div>
                </div>
            `;
        }
    </script>
</body>
</html>
