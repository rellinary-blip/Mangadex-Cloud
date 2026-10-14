// ==UserScript==
// @name         MangaDex - Cloud
// @namespace    https://mangadex.org/
// @version      1.1
// @description  Cloud-synchronized personal notes, custom rating formula, and ranking database for MangaDex.
// @author       rellinary-blip
// @license      MIT
// @icon         https://mangadex.org/favicon.ico
// @match        *://mangadex.org/*
// @grant        none
// @downloadURL https://update.greasyfork.org/scripts/600148/MangaDex%20-%20Cloud.user.js
// @updateURL https://update.greasyfork.org/scripts/600148/MangaDex%20-%20Cloud.meta.js
// ==/UserScript==

(function() {
    'use strict';

    const GIST_FILENAME = "mangadex-data.json";

    // =========================================================================
    // AUTHENTICATION & STORAGE MODE ('cloud' | 'local' | null)
    // =========================================================================
    let authConfig = JSON.parse(localStorage.getItem('md-cloud-auth')) || null;

    function isConfigured() {
        if (!authConfig || !authConfig.mode) return false;
        if (authConfig.mode === 'local') return true;
        if (authConfig.mode === 'cloud' && authConfig.gistId && authConfig.token) return true;
        return false;
    }

    function isCloudMode() {
        return isConfigured() && authConfig.mode === 'cloud';
    }

    // =========================================================================
    // PROFILE & SETTINGS MANAGEMENT
    // =========================================================================
    let activeProfile = localStorage.getItem('md-active-profile');
    if (!activeProfile) {
        activeProfile = 'desktop';
        localStorage.setItem('md-active-profile', activeProfile);
    }

    function createDefaultProfileSettings(profileName = 'desktop', existing = {}) {
        return {
            sync: { enabled: true, mode: "4s", customSeconds: 60, ...(existing.sync || {}) },
            title: { enabled: true, showOriginalRating: true, showRank: true, showNotes: true, ...(existing.title || {}) },
            carousel: { enabled: true, position: "tags", corner: "top-left", showStar: true, showRank: true, showNote: true, ...(existing.carousel || {}) },
            latest: { enabled: true, position: "latest", showStar: true, ...(existing.latest || {}) },
            feed: { enabled: true, position: "cover", corner: "bottom-right", showStar: true, ...(existing.feed || {}) },
            search: { enabled: true, originalRatingMode: "on", ...(existing.search || {}) },
            searchBar: { enabled: true, showOriginalRating: false, showRank: true, ...(existing.searchBar || {}) }
        };
    }

    let notesCache = null;
    let ratingsCache = null;
    let isFetching = false;
    let isDirty = false;
    let isSaving = false;
    let hasFetchFailed = false;
    let autoSaveTimer = null;

    let settingsCache = JSON.parse(localStorage.getItem('md-custom-settings'));
    if (!settingsCache || typeof settingsCache !== 'object') {
        settingsCache = {
            desktop: createDefaultProfileSettings('desktop')
        };
    }

    function getActiveSettings() {
        if (!settingsCache[activeProfile]) {
            activeProfile = Object.keys(settingsCache)[0] || 'desktop';
            localStorage.setItem('md-active-profile', activeProfile);
        }
        settingsCache[activeProfile] = createDefaultProfileSettings(activeProfile, settingsCache[activeProfile]);
        return settingsCache[activeProfile];
    }

    window.addEventListener('beforeunload', (e) => {
        if (isCloudMode() && (isDirty || isSaving)) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    // =========================================================================
    // DATA SYNCHRONIZATION ENGINE
    // =========================================================================
    function getSyncDelayMs(syncCfg) {
        if (!syncCfg || !syncCfg.mode) return 4000;
        if (syncCfg.mode === '4s') return 4000;
        if (syncCfg.mode === '1m') return 60000;
        if (syncCfg.mode === '10m') return 600000;
        if (syncCfg.mode === 'custom') {
            const sec = Math.max(1, parseInt(syncCfg.customSeconds, 10) || 60);
            return sec * 1000;
        }
        return 4000;
    }

    function markDirtyAndScheduleSave() {
        localStorage.setItem('md-custom-data-backup', JSON.stringify({
            notes: notesCache || {},
            ratings: ratingsCache || {}
        }));

        if (!isCloudMode()) {
            isDirty = false;
            updateSyncIconUI();
            return;
        }

        if (hasFetchFailed) return;
        isDirty = true;
        updateSyncIconUI();

        const syncCfg = getActiveSettings().sync;
        if (!syncCfg || !syncCfg.enabled) {
            if (autoSaveTimer) {
                clearTimeout(autoSaveTimer);
                autoSaveTimer = null;
            }
            return;
        }

        const delayMs = getSyncDelayMs(syncCfg);

        if (delayMs <= 15000) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = setTimeout(() => {
                autoSaveTimer = null;
                if (isDirty && !isSaving && !hasFetchFailed) {
                    saveNotesToCloud();
                }
            }, delayMs);
        } else if (!autoSaveTimer) {
            autoSaveTimer = setTimeout(() => {
                autoSaveTimer = null;
                if (isDirty && !isSaving && !hasFetchFailed) {
                    saveNotesToCloud();
                }
            }, delayMs);
        }
    }

    async function fetchNotes() {
        if (!isConfigured()) return;
        if (notesCache !== null || isFetching) return;

        if (!isCloudMode()) {
            const backup = JSON.parse(localStorage.getItem('md-custom-data-backup'));
            notesCache = (backup && backup.notes) ? backup.notes : {};
            ratingsCache = (backup && backup.ratings) ? backup.ratings : {};
            hasFetchFailed = false;
            updateSyncIconUI();
            routeAndExecute();
            return;
        }

        isFetching = true;
        try {
            const response = await fetch(`https://api.github.com/gists/${authConfig.gistId}`, {
                headers: {
                    'Authorization': `token ${authConfig.token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (!response.ok) {
                throw new Error(`GitHub API HTTP Error: ${response.status}`);
            }

            const data = await response.json();
            const fileObj = data.files && data.files[GIST_FILENAME];
            const record = (fileObj && fileObj.content) ? JSON.parse(fileObj.content) : {};

            notesCache = record.notes || {};
            ratingsCache = record.ratings || {};

            if (record.settings && typeof record.settings === 'object') {
                const normalizedAll = {};
                for (const [profName, profData] of Object.entries(record.settings)) {
                    normalizedAll[profName] = createDefaultProfileSettings(profName, profData);
                }
                settingsCache = normalizedAll;
                localStorage.setItem('md-custom-settings', JSON.stringify(settingsCache));
            }

            hasFetchFailed = false;
            localStorage.setItem('md-custom-data-backup', JSON.stringify({ notes: notesCache, ratings: ratingsCache }));

        } catch (error) {
            console.error("MangaDex Cloud: Failed to fetch cloud data. Loading local backup (Read-Only Protection Mode)...", error);
            hasFetchFailed = true;

            const backup = JSON.parse(localStorage.getItem('md-custom-data-backup'));
            notesCache = (backup && backup.notes) ? backup.notes : {};
            ratingsCache = (backup && backup.ratings) ? backup.ratings : {};
        }
        isFetching = false;
        updateSyncIconUI();
        routeAndExecute();
    }

    async function saveNotesToCloud() {
        localStorage.setItem('md-custom-data-backup', JSON.stringify({
            notes: notesCache || {},
            ratings: ratingsCache || {}
        }));

        if (!isCloudMode()) {
            isDirty = false;
            updateSyncIconUI();
            return;
        }

        if (hasFetchFailed || isSaving) return;
        isSaving = true;
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
        updateSyncIconUI();

        try {
            const payload = {
                settings: settingsCache,
                notes: notesCache,
                ratings: ratingsCache
            };

            const gistData = {
                files: {
                    [GIST_FILENAME]: {
                        content: JSON.stringify(payload, null, 2)
                    }
                }
            };

            const response = await fetch(`https://api.github.com/gists/${authConfig.gistId}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `token ${authConfig.token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(gistData)
            });

            if (!response.ok) {
                throw new Error(`GitHub PATCH Error: ${response.status}`);
            }

            isDirty = false;
            isSaving = false;
            updateSyncIconUI();

        } catch (error) {
            isSaving = false;
            updateSyncIconUI();
            alert("Failed to sync data to GitHub Cloud!");
            console.error(error);
        }
    }

    // =========================================================================
    // DOM UTILITIES & TITLE PAGE NOTES UI
    // =========================================================================
    function getMangaId() {
        const match = window.location.pathname.match(/^\/title\/([a-f0-9\-]+)/);
        return match ? match[1] : null;
    }

    function buildEl(tag, className = "", text = "") {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text) el.textContent = text;
        return el;
    }

    function cloneMangaDexButton(buttonsContainer, text, colorClass, extraClass = "", minHeight = "") {
        const baseButton = Array.from(buttonsContainer.querySelectorAll('button.md-btn'))
        .find(b => b.className.includes('accent') && !b.className.includes('primary')) || buttonsContainer.querySelector('button.md-btn');

        const btn = baseButton.cloneNode(true);
        btn.id = "";
        btn.disabled = false;

        let newClassName = btn.className.replace(/\b(primary|accent|accent-alt|danger|text|glow|disabled)\b/g, '').replace('px-0!', '').replace(/\s+/g, ' ').trim();
        btn.className = `${newClassName} ${colorClass} ${extraClass}`;

        btn.style.minWidth = '7rem';
        if (minHeight) btn.style.minHeight = minHeight;

        while (btn.firstChild) {
            btn.removeChild(btn.firstChild);
        }

        const span = document.createElement('span');
        span.className = 'flex relative items-center justify-center font-medium select-none w-full pointer-events-none';
        span.style.justifyContent = 'center';
        span.textContent = text;

        Array.from(btn.attributes).forEach(attr => {
            if (attr.name.startsWith('data-v-')) {
                span.setAttribute(attr.name, "");
            }
        });

        btn.appendChild(span);
        return { btn, span };
    }

    function injectUI() {
        const cfg = getActiveSettings().title;
        if (!cfg.enabled || !cfg.showNotes) return;

        const mangaId = getMangaId();
        if (!mangaId) return;

        const buttonsContainer = document.querySelector('[style*="grid-area: buttons"] .flex, [style*="grid-row-start: buttons"] .flex');
        const synopsisContainer = document.querySelector('[style*="grid-area: synopsis"], [style*="grid-row-start: synopsis"]');

        if (!buttonsContainer || !synopsisContainer) return;
        if (!buttonsContainer.querySelector('button.md-btn')) return;

        const existingBtn = document.getElementById('md-custom-note-btn');
        if (existingBtn) {
            if (existingBtn.dataset.mangaId === mangaId) return;
            existingBtn.remove();
            const oldBox = document.getElementById('md-custom-note-box');
            if (oldBox) oldBox.remove();
        }

        if (typeof observer !== 'undefined') observer.disconnect();

        const existingNote = (notesCache && notesCache[mangaId]) ? notesCache[mangaId] : "";

        const uploadBtn = buttonsContainer.querySelector('a[href*="upload"]');
        if (uploadBtn) uploadBtn.style.display = 'none';

        const btnColorClass = existingNote ? "primary glow" : "accent";
        const btnText = existingNote ? "Edit Note" : "Add Note";

        const { btn: noteBtn, span: noteBtnSpan } = cloneMangaDexButton(buttonsContainer, btnText, btnColorClass);
        noteBtn.id = 'md-custom-note-btn';
        noteBtn.dataset.mangaId = mangaId;

        if (buttonsContainer.children.length > 1) {
            buttonsContainer.insertBefore(noteBtn, buttonsContainer.children[1]);
        } else {
            buttonsContainer.appendChild(noteBtn);
        }

        // Modern Note Card
        const noteBox = buildEl('div', 'mt-4 rounded-lg bg-accent border border-accent-20 shadow-md');
        noteBox.id = 'md-custom-note-box';
        noteBox.dataset.mangaId = mangaId;
        noteBox.style.display = existingNote ? 'block' : 'none';
        noteBox.style.padding = '14px 18px';
        noteBox.style.borderLeft = '4px solid rgb(var(--md-primary))';
        noteBox.style.maxWidth = '100%';
        noteBox.style.boxSizing = 'border-box';
        noteBox.style.overflow = 'hidden';

        // Card Header
        const headerDiv = buildEl('div', 'flex justify-between items-center border-b border-accent-20');
        headerDiv.style.paddingBottom = '8px';
        headerDiv.style.marginBottom = '10px';

        const titleGroup = buildEl('div', 'flex items-center text-primary');
        titleGroup.style.gap = '8px';

        const svgNS = "http://www.w3.org/2000/svg";
        const noteIcon = document.createElementNS(svgNS, "svg");
        noteIcon.setAttribute("width", "16");
        noteIcon.setAttribute("height", "16");
        noteIcon.setAttribute("viewBox", "0 0 24 24");
        noteIcon.setAttribute("fill", "none");
        noteIcon.setAttribute("stroke", "currentColor");
        noteIcon.setAttribute("stroke-width", "2.2");
        noteIcon.setAttribute("stroke-linecap", "round");
        noteIcon.setAttribute("stroke-linejoin", "round");
        const iconPath1 = document.createElementNS(svgNS, "path");
        iconPath1.setAttribute("d", "M12 20h9");
        const iconPath2 = document.createElementNS(svgNS, "path");
        iconPath2.setAttribute("d", "M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z");
        noteIcon.appendChild(iconPath1);
        noteIcon.appendChild(iconPath2);

        const headerTitle = buildEl('span', 'font-bold text-xs uppercase tracking-wider', 'Personal Note');
        titleGroup.appendChild(noteIcon);
        titleGroup.appendChild(headerTitle);

        const quickEditBtn = buildEl('button', 'text-xs font-bold text-midTone hover:text-primary rounded transition-colors cursor-pointer select-none', '✎ Edit');
        quickEditBtn.type = 'button';
        quickEditBtn.style.padding = '3px 8px';
        quickEditBtn.style.backgroundColor = 'rgb(var(--md-background) / 60%)';

        headerDiv.appendChild(titleGroup);
        headerDiv.appendChild(quickEditBtn);

        // Note Display Area (Overflow-safe)
        const displayDiv = buildEl('div', 'text-color');
        displayDiv.style.fontSize = '0.925rem';
        displayDiv.style.lineHeight = '1.6';
        displayDiv.style.whiteSpace = 'pre-wrap';
        displayDiv.style.overflowWrap = 'anywhere';
        displayDiv.style.wordBreak = 'break-word';
        displayDiv.style.maxWidth = '100%';
        displayDiv.textContent = existingNote || "";

        // Editor Textarea
        const inputArea = buildEl('textarea', 'w-full bg-background text-color rounded border border-accent-20 outline-none focus:border-primary transition-colors');
        inputArea.id = 'md-custom-note-textarea';
        inputArea.style.display = 'none';
        inputArea.style.padding = '10px 12px';
        inputArea.style.fontSize = '0.925rem';
        inputArea.style.lineHeight = '1.5';
        inputArea.style.resize = 'vertical';
        inputArea.style.minHeight = '84px';
        inputArea.style.boxSizing = 'border-box';
        inputArea.rows = 3;
        inputArea.placeholder = 'Write your personal note here...';
        inputArea.value = existingNote || "";

        function autoResizeTextarea() {
            inputArea.style.height = 'auto';
            inputArea.style.height = Math.max(84, inputArea.scrollHeight) + 'px';
        }
        inputArea.addEventListener('input', autoResizeTextarea);

        // Action Bar (Shortcut Hint + Cancel/Save Buttons)
        const actionDiv = buildEl('div', 'flex justify-between items-center');
        actionDiv.style.display = 'none';
        actionDiv.style.marginTop = '10px';
        actionDiv.style.gap = '8px';

        const shortcutHint = buildEl('span', 'text-xs text-midTone select-none', 'Ctrl+Enter to save • Esc to cancel');
        shortcutHint.style.fontSize = '0.7rem';

        const btnGroup = buildEl('div', 'flex items-center');
        btnGroup.style.gap = '8px';

        const cancelBtn = buildEl('button', 'rounded bg-background hover:bg-accent-20 text-color border border-accent-20 text-xs font-bold transition-colors cursor-pointer', 'Cancel');
        cancelBtn.type = 'button';
        cancelBtn.style.padding = '7px 14px';

        const saveBtn = buildEl('button', 'rounded bg-primary text-white text-xs font-bold hover:opacity-85 transition-opacity cursor-pointer shadow', 'Save Note');
        saveBtn.type = 'button';
        saveBtn.style.padding = '7px 16px';

        btnGroup.appendChild(cancelBtn);
        btnGroup.appendChild(saveBtn);
        actionDiv.appendChild(shortcutHint);
        actionDiv.appendChild(btnGroup);

        noteBox.appendChild(headerDiv);
        noteBox.appendChild(displayDiv);
        noteBox.appendChild(inputArea);
        noteBox.appendChild(actionDiv);

        synopsisContainer.appendChild(noteBox);

        function openEditor() {
            noteBox.style.display = 'block';
            displayDiv.style.display = 'none';
            quickEditBtn.style.display = 'none';
            inputArea.style.display = 'block';
            actionDiv.style.display = 'flex';
            autoResizeTextarea();
            inputArea.focus();
            inputArea.selectionStart = inputArea.selectionEnd = inputArea.value.length;
        }

        noteBtn.addEventListener('click', openEditor);
        quickEditBtn.addEventListener('click', openEditor);

        cancelBtn.addEventListener('click', () => {
            inputArea.value = notesCache[mangaId] || "";
            inputArea.style.display = 'none';
            actionDiv.style.display = 'none';
            quickEditBtn.style.display = 'inline-block';
            if (notesCache[mangaId]) {
                displayDiv.style.display = 'block';
            } else {
                noteBox.style.display = 'none';
            }
        });

        saveBtn.addEventListener('click', () => {
            const newText = inputArea.value.trim();
            if (newText === (notesCache[mangaId] || "")) return cancelBtn.click();

            if (newText === "") delete notesCache[mangaId];
            else notesCache[mangaId] = newText;

            markDirtyAndScheduleSave();

            inputArea.style.display = 'none';
            actionDiv.style.display = 'none';
            quickEditBtn.style.display = 'inline-block';
            displayDiv.textContent = newText;

            let currentClass = noteBtn.className.replace(/\b(primary|accent|glow)\b/g, '').replace(/\s+/g, ' ').trim();
            if (newText === "") {
                noteBox.style.display = 'none';
                noteBtn.className = `${currentClass} accent`;
                noteBtnSpan.textContent = "Add Note";
            } else {
                displayDiv.style.display = 'block';
                noteBtn.className = `${currentClass} primary glow`;
                noteBtnSpan.textContent = "Edit Note";
            }
        });

        inputArea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                saveBtn.click();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelBtn.click();
            }
        });

        if (typeof observer !== 'undefined') {
            const target = document.getElementById('app') || document.body;
            observer.observe(target, { childList: true, subtree: true });
        }
    }

    // =========================================================================
    // RATING FORMULA, RANKING & BADGE RENDERERS
    // =========================================================================
    function calculateColors(newValue) {
        const t = Math.max(0, Math.min(1, (newValue) / 10));
        return { h: t * 180, s: 85, l: 65 - (t * 10) };
    }

    function getMangaRankInfo(mangaId, currentScore) {
        if (!ratingsCache) return null;
        let rank = 1;
        for (const [id, cachedScore] of Object.entries(ratingsCache)) {
            if (id !== mangaId && cachedScore > currentScore) {
                rank++;
            }
        }
        const total = Object.keys(ratingsCache).length;
        return { rank, total };
    }

    function createRankBadgeElement(rankInfo, colorParams, isCoverMode = false) {
        const rankBadge = document.createElement('span');
        rankBadge.style.color = `hsl(${colorParams.h}, ${colorParams.s}%, ${colorParams.l}%)`;
        rankBadge.style.backgroundColor = `hsla(${colorParams.h}, ${colorParams.s}%, ${colorParams.l}%, ${isCoverMode ? 0.2 : 0.12})`;
        rankBadge.style.border = `1px solid hsla(${colorParams.h}, ${colorParams.s}%, ${colorParams.l}%, 0.35)`;
        rankBadge.style.padding = isCoverMode ? '0px 4px' : '1px 6px';
        rankBadge.style.borderRadius = '6px';
        rankBadge.style.fontSize = '0.75em';
        rankBadge.style.lineHeight = '1.2';
        rankBadge.style.marginLeft = isCoverMode ? '4px' : '6px';
        rankBadge.style.fontWeight = 'bold';
        rankBadge.style.letterSpacing = '0.02em';
        rankBadge.title = `Ranked #${rankInfo.rank} out of ${rankInfo.total} rated titles`;
        rankBadge.textContent = `#${rankInfo.rank}`;
        return rankBadge;
    }

    function createScoreElements(newText, originalValue, colorParams, showOriginal = true, rankInfo = null) {
        const scoreWrapper = document.createElement('span');
        scoreWrapper.className = 'custom-mangadex-rating';
        scoreWrapper.style.color = `hsl(${colorParams.h}, ${colorParams.s}%, ${colorParams.l}%)`;
        scoreWrapper.style.fontWeight = 'bold';
        scoreWrapper.style.marginLeft = '4px';
        scoreWrapper.style.display = 'inline-flex';
        scoreWrapper.style.alignItems = 'baseline';

        const newScoreSpan = document.createElement('span');
        newScoreSpan.textContent = newText;
        scoreWrapper.appendChild(newScoreSpan);

        if (showOriginal) {
            const oldScoreSpan = document.createElement('span');
            oldScoreSpan.style.color = '#FFFFFF';
            oldScoreSpan.style.opacity = '0.4';
            oldScoreSpan.style.fontSize = '0.85em';
            oldScoreSpan.style.fontWeight = 'normal';
            oldScoreSpan.style.marginLeft = '4px';
            oldScoreSpan.textContent = `(${originalValue.toFixed(2)})`;
            scoreWrapper.appendChild(oldScoreSpan);
        }

        if (rankInfo !== null) {
            const badge = createRankBadgeElement(rankInfo, colorParams, false);
            badge.style.alignSelf = 'center';
            scoreWrapper.appendChild(badge);
        }

        return scoreWrapper;
    }

    function checkAndSaveRating() {
        const mangaId = getMangaId();
        if (!mangaId || ratingsCache === null) return;

        const statContainer = document.querySelector('[title*="Bayesian"]');
        if (!statContainer) return;

        const span = statContainer.querySelector('span.text-primary');
        if (!span) return;

        const existingRating = span.querySelector('.custom-mangadex-rating');
        if (existingRating) {
            if (existingRating.dataset.mangaId === mangaId) return;
            existingRating.remove();
        }

        const match = statContainer.getAttribute('title').match(/([\d.]+)\s*\(Bayesian\)/i);
        if (!match) return;

        const originalValue = parseFloat(match[1]);
        if (isNaN(originalValue) || originalValue <= 0) return;

        let newValue = -0.03256 * Math.pow((originalValue - 5.5), 2) + 2.5177 * (originalValue - 5.5);
        let finalScore = Number(newValue.toFixed(2));

        let oldScore = ratingsCache[mangaId];
        let diff = Math.abs((oldScore || 0) - finalScore);

        if (oldScore === undefined || diff > 0.0301) {
            ratingsCache[mangaId] = finalScore;
            markDirtyAndScheduleSave();
        }

        const titleCfg = getActiveSettings().title;
        if (!titleCfg.enabled) return;

        if (typeof observer !== 'undefined') observer.disconnect();

        const rankInfo = titleCfg.showRank ? getMangaRankInfo(mangaId, finalScore) : null;
        const newText = finalScore.toFixed(2);
        const colors = calculateColors(finalScore);
        const scoreElements = createScoreElements(newText, originalValue, colors, titleCfg.showOriginalRating, rankInfo);
        scoreElements.dataset.mangaId = mangaId;

        for (let node of span.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) node.textContent = '';
        }
        span.prepend(scoreElements);

        if (typeof observer !== 'undefined') {
            const target = document.getElementById('app') || document.body;
            observer.observe(target, { childList: true, subtree: true });
        }
    }

    function checkAndSaveSearchRatings() {
        if (ratingsCache === null) return;

        const searchCfg = getActiveSettings().search;
        const unprocessedStats = document.querySelectorAll('.manga-card .stat:not([data-processed="true"])');
        if (unprocessedStats.length === 0) return;

        let updatedCount = 0;
        const isFollowsPage = window.location.pathname === '/titles/follows';
        const showOriginal = searchCfg.originalRatingMode === 'on' || (searchCfg.originalRatingMode === 'no-follows' && !isFollowsPage);

        if (typeof observer !== 'undefined') observer.disconnect();

        unprocessedStats.forEach((stat) => {
            const starIcon = stat.querySelector('svg.feather-star');
            if (!starIcon) return;

            const card = stat.closest('.manga-card');
            if (!card) return;

            const link = card.querySelector('a[href*="/title/"]');
            if (!link) return;

            const match = link.getAttribute('href').match(/\/title\/([a-f0-9\-]+)/);
            if (!match) return;
            const mangaId = match[1];

            let originalValue = 0;
            stat.childNodes.forEach(node => {
                if (node.nodeType === Node.TEXT_NODE) {
                    const parsed = parseFloat(node.textContent.trim());
                    if (!isNaN(parsed) && parsed > 0) originalValue = parsed;
                }
            });

            if (originalValue <= 0) return;

            let newValue = -0.03256 * Math.pow((originalValue - 5.5), 2) + 2.5177 * (originalValue - 5.5);
            let finalScore = Number(newValue.toFixed(2));

            if (searchCfg.enabled) {
                const newText = finalScore.toFixed(2);
                const colors = calculateColors(finalScore);
                const scoreElements = createScoreElements(newText, originalValue, colors, showOriginal, null);

                for (let node of stat.childNodes) {
                    if (node.nodeType === Node.TEXT_NODE) node.textContent = '';
                }
                stat.appendChild(scoreElements);
            }
            stat.dataset.processed = "true";

            let oldScore = ratingsCache[mangaId];
            let diff = Math.abs((oldScore || 0) - finalScore);

            if (oldScore === undefined || diff > 0.0301) {
                ratingsCache[mangaId] = finalScore;
                updatedCount++;
            }
        });

        if (updatedCount > 0) {
            markDirtyAndScheduleSave();
        }

        if (typeof observer !== 'undefined') {
            const target = document.getElementById('app') || document.body;
            observer.observe(target, { childList: true, subtree: true });
        }
    }

    function checkAndSaveNavbarSearchRatings() {
        const resultsContainer = document.querySelector('.nav-bar-search__results');
        if (!resultsContainer) return;

        if (ratingsCache === null) {
            fetchNotes();
            return;
        }

        const cards = resultsContainer.querySelectorAll('a.manga-card-dense');
        if (cards.length === 0) return;

        const searchBarCfg = getActiveSettings().searchBar;
        let updatedCount = 0;

        if (typeof observer !== 'undefined') observer.disconnect();

        cards.forEach((card) => {
            const href = card.getAttribute('href') || '';
            const match = href.match(/\/title\/([a-f0-9\-]+)/);
            if (!match) return;
            const mangaId = match[1];

            // Skip only if this exact mangaId was already processed on this card
            if (card.dataset.navSearchMangaId === mangaId) return;

            const statsGrid = card.querySelector('[style*="grid-area: stats"], [style*="grid-row-start: stats"]') || card;
            const starIcon = statsGrid.querySelector('svg.feather-star');
            if (!starIcon) return;

            const stat = starIcon.parentElement;
            if (!stat) return;

            // Remove old custom badge if Vue reused the card for a new search result
            const oldCustom = stat.querySelector('.custom-mangadex-rating');
            if (oldCustom) oldCustom.remove();

            let originalValue = 0;
            if (stat.getAttribute('title')) {
                const parsedTitle = parseFloat(stat.getAttribute('title'));
                if (!isNaN(parsedTitle) && parsedTitle > 0) originalValue = parsedTitle;
            }

            if (originalValue <= 0) {
                stat.childNodes.forEach(node => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        const parsed = parseFloat(node.textContent.trim());
                        if (!isNaN(parsed) && parsed > 0) originalValue = parsed;
                    }
                });
            }

            if (originalValue <= 0) return;

            card.dataset.navSearchMangaId = mangaId;

            let newValue = -0.03256 * Math.pow((originalValue - 5.5), 2) + 2.5177 * (originalValue - 5.5);
            let finalScore = Number(newValue.toFixed(2));

            let oldScore = ratingsCache[mangaId];
            let diff = Math.abs((oldScore || 0) - finalScore);

            if (oldScore === undefined || diff > 0.0301) {
                ratingsCache[mangaId] = finalScore;
                updatedCount++;
            }

            if (searchBarCfg.enabled) {
                const rankInfo = searchBarCfg.showRank ? getMangaRankInfo(mangaId, finalScore) : null;
                const newText = finalScore.toFixed(2);
                const colors = calculateColors(finalScore);
                const scoreElements = createScoreElements(newText, originalValue, colors, searchBarCfg.showOriginalRating, rankInfo);

                for (let node of stat.childNodes) {
                    if (node.nodeType === Node.TEXT_NODE) node.textContent = '';
                }
                stat.appendChild(scoreElements);
            }
        });

        if (updatedCount > 0) {
            markDirtyAndScheduleSave();
        }

        if (typeof observer !== 'undefined') {
            const target = document.getElementById('app') || document.body;
            observer.observe(target, { childList: true, subtree: true });
        }
    }

    function createCustomBadge(score, config, colorParams, rankInfo = null) {
        const badge = document.createElement('span');
        badge.className = 'custom-mangadex-badge';

        badge.style.color = `hsl(${colorParams.h}, ${colorParams.s}%, ${colorParams.l}%)`;
        badge.style.fontWeight = 'bold';
        badge.style.display = 'inline-flex';
        badge.style.alignItems = 'center';

        if (config.position === "cover") {
            badge.style.position = 'absolute';
            badge.style.zIndex = '1';
            badge.style.backgroundColor = 'rgba(0, 0, 0, 0.75)';
            badge.style.padding = '2px 6px';
            badge.style.borderRadius = '4px';
            badge.style.fontSize = '0.85em';

            if (config.corner.includes('top')) badge.style.top = '4px';
            if (config.corner.includes('bottom')) badge.style.bottom = '4px';
            if (config.corner.includes('left')) badge.style.left = '4px';
            if (config.corner.includes('right')) badge.style.right = '4px';
        } else {
            if (config.position === "flag") {
                badge.style.margin = '0 8px';
                badge.style.fontSize = '0.95em';
            } else if (config.position === "right") {
                badge.style.marginLeft = 'auto';
                badge.style.fontSize = '0.95em';
            } else if (config.position === "tags") {
                badge.style.marginRight = '8px';
                badge.style.fontSize = '1em';
                badge.style.flex = '0 0 auto';
                badge.style.width = 'max-content';
                badge.style.height = 'fit-content';
                badge.style.marginTop = 'auto';
                badge.style.marginBottom = 'auto';
            } else if (config.position === "latest") {
                badge.style.fontSize = '0.9em';
                badge.style.alignSelf = 'center';
            }
        }

        if (config.showStar) {
            const svgNS = "http://www.w3.org/2000/svg";
            const svgEl = document.createElementNS(svgNS, "svg");
            svgEl.setAttribute("width", "16");
            svgEl.setAttribute("height", "16");
            svgEl.setAttribute("fill", "none");
            svgEl.setAttribute("stroke", "currentColor");
            svgEl.setAttribute("stroke-width", "2");
            svgEl.setAttribute("stroke-linecap", "round");
            svgEl.setAttribute("stroke-linejoin", "round");
            svgEl.style.marginRight = "4px";
            svgEl.setAttribute("viewBox", "0 0 24 24");

            const pathEl = document.createElementNS(svgNS, "path");
            pathEl.setAttribute("d", "m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z");

            svgEl.appendChild(pathEl);
            badge.appendChild(svgEl);
        }

        const scoreText = document.createTextNode(score.toFixed(2));
        badge.appendChild(scoreText);

        if (rankInfo !== null) {
            const isCoverMode = config.position === "cover";
            badge.appendChild(createRankBadgeElement(rankInfo, colorParams, isCoverMode));
        }

        return badge;
    }

    function injectFeedRatings() {
        if (ratingsCache === null) return;
        const feedCfg = getActiveSettings().feed;
        if (!feedCfg.enabled) return;

        const feedCards = document.querySelectorAll('.chapter-feed__container:not([data-badge-processed="true"]), .expand:not([data-badge-processed="true"])');
        if (feedCards.length === 0) return;

        if (typeof observer !== 'undefined') observer.disconnect();

        feedCards.forEach(card => {
            card.dataset.badgeProcessed = "true";

            const titleLink = card.querySelector('a.chapter-feed__title');
            if (!titleLink) return;

            const match = titleLink.getAttribute('href').match(/\/title\/([a-f0-9\-]+)/);
            if (!match) return;
            const mangaId = match[1];

            const score = ratingsCache[mangaId];
            if (score === undefined) return;

            const colors = calculateColors(score);
            const badgeElement = createCustomBadge(score, feedCfg, colors);

            if (feedCfg.position === "cover") {
                const coverImageContainer = card.querySelector('.chapter-feed__cover-image');
                if (coverImageContainer) {
                    coverImageContainer.style.isolation = 'isolate';
                    coverImageContainer.appendChild(badgeElement);
                }
            } else if (feedCfg.position === "flag") {
                const flagImg = titleLink.querySelector('img[src*="/flags/"]');
                if (flagImg && flagImg.nextSibling) {
                    titleLink.insertBefore(badgeElement, flagImg.nextSibling);
                } else {
                    titleLink.prepend(badgeElement);
                }
            } else if (feedCfg.position === "right") {
                titleLink.style.display = 'flex';
                titleLink.style.alignItems = 'center';
                titleLink.style.width = '100%';
                titleLink.style.paddingRight = '8px';
                titleLink.appendChild(badgeElement);
            }
        });

        if (typeof observer !== 'undefined') {
            const target = document.getElementById('app') || document.body;
            observer.observe(target, { childList: true, subtree: true });
        }
    }

    function injectCarouselUI() {
        if (ratingsCache === null && notesCache === null) return;
        const carouselCfg = getActiveSettings().carousel;
        if (!carouselCfg.enabled) return;

        const slides = document.querySelectorAll('.swiper-slide:not([data-carousel-processed="true"])');
        if (slides.length === 0) return;

        if (typeof observer !== 'undefined') observer.disconnect();

        slides.forEach(slide => {
            slide.dataset.carouselProcessed = "true";

            const mainLink = slide.querySelector('a[href*="/title/"]');
            if (!mainLink) return;

            const match = mainLink.getAttribute('href').match(/\/title\/([a-f0-9\-]+)/);
            if (!match) return;
            const mangaId = match[1];

            const score = ratingsCache ? ratingsCache[mangaId] : undefined;
            if (score !== undefined) {
                const colors = calculateColors(score);
                const rankInfo = carouselCfg.showRank ? getMangaRankInfo(mangaId, score) : null;

                if (carouselCfg.position === "cover") {
                    const badgeElement = createCustomBadge(score, carouselCfg, colors, null);
                    const coverContainer = slide.querySelector('a.group.flex.items-start');
                    if (coverContainer) {
                        coverContainer.style.position = 'relative';
                        coverContainer.appendChild(badgeElement);
                    }

                    if (rankInfo !== null) {
                        const tagsContainer = slide.querySelector('.flex.flex-wrap.gap-1');
                        if (tagsContainer) {
                            const standaloneRank = createRankBadgeElement(rankInfo, colors, false);
                            standaloneRank.style.marginLeft = '0px';
                            standaloneRank.style.marginRight = '4px';
                            standaloneRank.style.height = 'fit-content';
                            standaloneRank.style.alignSelf = 'center';
                            tagsContainer.insertBefore(standaloneRank, tagsContainer.firstChild);
                        }
                    }
                } else if (carouselCfg.position === "tags") {
                    const badgeElement = createCustomBadge(score, carouselCfg, colors, rankInfo);
                    const tagsContainer = slide.querySelector('.flex.flex-wrap.gap-1');
                    if (tagsContainer) {
                        tagsContainer.insertBefore(badgeElement, tagsContainer.firstChild);
                    }
                }
            }

            const note = (carouselCfg.showNote && notesCache) ? notesCache[mangaId] : undefined;
            if (note) {
                const synopsisContainer = slide.querySelector('.md-md-container');
                if (synopsisContainer) {
                    const originalNodes = Array.from(synopsisContainer.childNodes);

                    while (synopsisContainer.firstChild) {
                        synopsisContainer.removeChild(synopsisContainer.firstChild);
                    }

                    const noteHeader = document.createElement('p');
                    noteHeader.className = 'text-primary';
                    noteHeader.style.fontWeight = 'bold';
                    noteHeader.style.fontSize = '1.3rem';
                    noteHeader.style.marginBottom = '4px';
                    noteHeader.textContent = '-Personal Note-';

                    const noteContent = document.createElement('p');
                    noteContent.style.whiteSpace = 'pre-wrap';
                    noteContent.style.overflowWrap = 'anywhere';
                    noteContent.style.wordBreak = 'break-word';
                    noteContent.style.marginBottom = '12px';
                    noteContent.style.fontStyle = 'italic';
                    noteContent.textContent = note;

                    const synopsisHeader = document.createElement('p');
                    synopsisHeader.style.fontWeight = 'bold';
                    synopsisHeader.style.fontSize = '1.3rem';
                    synopsisHeader.style.marginBottom = '4px';
                    synopsisHeader.textContent = '-Synopsis-';

                    synopsisContainer.appendChild(noteHeader);
                    synopsisContainer.appendChild(noteContent);
                    synopsisContainer.appendChild(synopsisHeader);

                    originalNodes.forEach(node => synopsisContainer.appendChild(node));
                }
            }
        });

        if (typeof observer !== 'undefined') {
            const target = document.getElementById('app') || document.body;
            observer.observe(target, { childList: true, subtree: true });
        }
    }

    function injectLatestUpdatesRatings() {
        if (ratingsCache === null) return;
        const latestCfg = getActiveSettings().latest;
        if (!latestCfg.enabled) return;

        const chapterCards = document.querySelectorAll('.hchaptercard:not([data-latest-processed="true"])');
        if (chapterCards.length === 0) return;

        if (typeof observer !== 'undefined') observer.disconnect();

        chapterCards.forEach(card => {
            card.dataset.latestProcessed = "true";

            const mangaLink = card.querySelector('a[href*="/title/"]');
            if (!mangaLink) return;

            const match = mangaLink.getAttribute('href').match(/\/title\/([a-f0-9\-]+)/);
            if (!match) return;
            const mangaId = match[1];

            const score = ratingsCache[mangaId];
            if (score !== undefined) {
                const commentBtn = card.querySelector('button.comment-container');
                if (commentBtn) {
                    commentBtn.style.display = 'none';

                    const colors = calculateColors(score);
                    const badgeElement = createCustomBadge(score, latestCfg, colors);

                    commentBtn.parentNode.insertBefore(badgeElement, commentBtn);
                }
            }
        });

        if (typeof observer !== 'undefined') {
            const target = document.getElementById('app') || document.body;
            observer.observe(target, { childList: true, subtree: true });
        }
    }

    // =========================================================================
    // LOCAL DATA WIPE UTILITY
    // =========================================================================
    function wipeAllLocalData() {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
        isDirty = false;
        isSaving = false;

        localStorage.removeItem('md-cloud-auth');
        localStorage.removeItem('md-custom-settings');
        localStorage.removeItem('md-active-profile');
        localStorage.removeItem('md-custom-data-backup');
        localStorage.removeItem('md-custom-modal-size');

        window.location.reload();
    }

    function createWipeDataComponent(titleText = 'Danger Zone: Wipe Local Data') {
        const container = buildEl('div', 'flex flex-col rounded-md border border-accent-20');
        container.style.padding = '14px';
        container.style.backgroundColor = 'rgb(var(--md-status-red) / 10%)';
        container.style.borderColor = 'rgb(var(--md-status-red) / 35%)';

        const header = buildEl('div', 'font-bold text-xs uppercase tracking-wider text-status-red', titleText);
        header.style.marginBottom = '6px';

        const infoText = buildEl('div', 'text-xs text-midTone');
        infoText.style.lineHeight = '1.45';
        infoText.style.marginBottom = '10px';

        const p1 = buildEl('p', '', 'This action only deletes the data stored locally in this browser (cache, settings, and login session) and logs you out.');
        p1.style.marginBottom = '6px';

        const p2 = buildEl('p', '');
        p2.appendChild(buildEl('span', 'font-bold text-color', '• If using Cloud Sync: '));
        p2.appendChild(buildEl('span', '', 'Your database on GitHub Gist is safe and will be restored when you log in again.'));
        p2.style.marginBottom = '4px';

        const p3 = buildEl('p', '');
        p3.appendChild(buildEl('span', 'font-bold text-status-red', '• If using Local-Only Mode: '));
        p3.appendChild(buildEl('span', '', 'All your notes and ratings will be permanently lost forever.'));

        infoText.appendChild(p1);
        infoText.appendChild(p2);
        infoText.appendChild(p3);

        const ackRow = buildEl('label', 'flex items-start cursor-pointer text-xs font-medium select-none');
        ackRow.style.gap = '10px';
        ackRow.style.marginBottom = '12px';

        const ackCheckbox = document.createElement('input');
        ackCheckbox.type = 'checkbox';
        ackCheckbox.style.marginTop = '2px';
        ackCheckbox.style.width = '16px';
        ackCheckbox.style.height = '16px';
        ackCheckbox.style.cursor = 'pointer';
        ackCheckbox.style.flexShrink = '0';

        const ackLabelText = buildEl('span', '', 'I have read and understand that this wipes all local browser data (Cloud data returns on re-login, Local-Only data is lost forever).');
        ackLabelText.style.lineHeight = '1.4';

        ackRow.appendChild(ackCheckbox);
        ackRow.appendChild(ackLabelText);

        const wipeBtn = buildEl('button', 'w-full rounded text-xs font-bold transition-opacity opacity-40 cursor-not-allowed', 'Wipe Local Data & Logout');
        wipeBtn.type = 'button';
        wipeBtn.style.padding = '10px 14px';
        wipeBtn.style.backgroundColor = 'rgb(var(--md-status-red))';
        wipeBtn.style.color = '#ffffff';
        wipeBtn.disabled = true;

        ackCheckbox.addEventListener('change', () => {
            if (ackCheckbox.checked) {
                wipeBtn.disabled = false;
                wipeBtn.className = 'w-full rounded text-xs font-bold transition-opacity hover:opacity-85 cursor-pointer shadow';
            } else {
                wipeBtn.disabled = true;
                wipeBtn.className = 'w-full rounded text-xs font-bold transition-opacity opacity-40 cursor-not-allowed';
            }
        });

        wipeBtn.addEventListener('click', () => {
            if (!ackCheckbox.checked) return;
            wipeAllLocalData();
        });

        container.appendChild(header);
        container.appendChild(infoText);
        container.appendChild(ackRow);
        container.appendChild(wipeBtn);

        return container;
    }

    // =========================================================================
    // ONBOARDING & SETUP MODAL
    // =========================================================================
    function injectOnboardingModal() {
        if (document.getElementById('md-custom-onboarding-modal')) return;

        const modal = buildEl('div', 'fixed inset-0 flex items-center justify-center');
        modal.id = 'md-custom-onboarding-modal';
        modal.style.zIndex = '10000';
        modal.style.display = 'none';

        const shade = buildEl('div', 'absolute inset-0');
        shade.style.backgroundColor = 'rgba(0, 0, 0, 0.65)';
        shade.style.backdropFilter = 'blur(4px)';

        const box = buildEl('div', 'relative bg-background rounded-lg border border-accent-20 shadow-2xl flex flex-col text-color select-none');
        box.style.width = '450px';
        box.style.maxWidth = 'calc(100vw - 24px)';
        box.style.maxHeight = 'calc(100vh - 32px)';
        box.style.padding = '22px';
        box.style.overflowY = 'auto';

        function closeOnboarding() {
            if (!isConfigured()) return;
            modal.style.display = 'none';
        }

        shade.addEventListener('click', closeOnboarding);

        function createLabelWithHelp(labelText, populateHelpBox, extraRightElement = null) {
            const wrapper = buildEl('div', 'flex flex-col');
            wrapper.style.marginBottom = '6px';

            const labelRow = buildEl('div', 'flex items-center justify-between');
            const leftGroup = buildEl('div', 'flex items-center');
            leftGroup.style.gap = '6px';

            const label = buildEl('label', 'text-xs font-medium', labelText);

            const helpBtn = buildEl('button', 'flex items-center justify-center rounded-full font-bold text-xs transition-colors cursor-pointer bg-accent-20 text-primary hover:bg-primary hover:text-white', '?');
            helpBtn.type = 'button';
            helpBtn.style.width = '18px';
            helpBtn.style.height = '18px';
            helpBtn.style.fontSize = '0.7rem';
            helpBtn.style.lineHeight = '1';
            helpBtn.title = 'Click for help';

            leftGroup.appendChild(label);
            leftGroup.appendChild(helpBtn);
            labelRow.appendChild(leftGroup);

            if (extraRightElement) {
                labelRow.appendChild(extraRightElement);
            }

            const helpBox = buildEl('div', 'rounded border border-accent-20 text-xs text-midTone');
            helpBox.style.backgroundColor = 'rgb(var(--md-background) / 85%)';
            helpBox.style.padding = '10px 12px';
            helpBox.style.marginTop = '6px';
            helpBox.style.lineHeight = '1.45';
            helpBox.style.display = 'none';

            populateHelpBox(helpBox);

            helpBtn.addEventListener('click', () => {
                const isHidden = helpBox.style.display === 'none';
                if (isHidden) {
                    helpBox.style.display = 'block';
                    helpBtn.className = 'flex items-center justify-center rounded-full font-bold text-xs transition-colors cursor-pointer bg-primary text-white';
                    helpBox.animate([
                        { opacity: 0, transform: 'translateY(-4px)' },
                        { opacity: 1, transform: 'translateY(0)' }
                    ], { duration: 150, easing: 'ease-out' });
                } else {
                    helpBtn.className = 'flex items-center justify-center rounded-full font-bold text-xs transition-colors cursor-pointer bg-accent-20 text-primary hover:bg-primary hover:text-white';
                    helpBox.style.display = 'none';
                }
            });

            wrapper.appendChild(labelRow);
            wrapper.appendChild(helpBox);
            return wrapper;
        }

        function renderOnboarding() {
            while (box.firstChild) box.removeChild(box.firstChild);

            const alreadyConfigured = isConfigured();

            const headerDiv = buildEl('div', 'flex justify-between items-center border-b border-accent-20');
            headerDiv.style.paddingBottom = '12px';
            headerDiv.style.marginBottom = '14px';

            const titleWrap = buildEl('div', 'flex flex-col');
            titleWrap.style.gap = '2px';
            titleWrap.appendChild(buildEl('span', 'font-bold text-lg text-primary', 'MangaDex Cloud Setup'));
            titleWrap.appendChild(buildEl('span', 'text-xs text-midTone', 'Configure database synchronization or local storage'));
            headerDiv.appendChild(titleWrap);

            if (alreadyConfigured) {
                const closeBtn = buildEl('button', 'text-midTone hover:text-color font-bold text-lg cursor-pointer', '×');
                closeBtn.style.padding = '4px 10px';
                closeBtn.addEventListener('click', closeOnboarding);
                headerDiv.appendChild(closeBtn);
            }
            box.appendChild(headerDiv);

            const privacyBox = buildEl('div', 'flex items-start rounded-md border border-accent-20 text-xs text-midTone');
            privacyBox.style.backgroundColor = 'rgb(var(--md-accent) / 40%)';
            privacyBox.style.padding = '10px 12px';
            privacyBox.style.marginBottom = '14px';
            privacyBox.style.gap = '10px';

            const lockIcon = buildEl('span', 'text-primary font-bold shrink-0', '🔒');
            const privacyText = buildEl('span', '', 'Privacy Guarantee: No data is ever sent to any third-party server. Your notes, ratings, and credentials stay strictly inside your browser (Local) and your personal GitHub Gist.');
            privacyText.style.lineHeight = '1.45';
            privacyBox.appendChild(lockIcon);
            privacyBox.appendChild(privacyText);
            box.appendChild(privacyBox);

            // Section 1: GitHub Cloud Sync
            const cloudSection = buildEl('div', 'flex flex-col rounded-md bg-accent');
            cloudSection.style.padding = '16px';
            cloudSection.style.marginBottom = '14px';

            const cloudTitle = buildEl('div', 'font-bold text-xs uppercase tracking-wider text-primary', '1. GitHub Gist Cloud Sync (Recommended)');
            cloudTitle.style.marginBottom = '12px';
            cloudSection.appendChild(cloudTitle);

            const tokenHeader = createLabelWithHelp('GitHub Personal Access Token:', (helpBox) => {
                const title = buildEl('div', 'font-bold text-color', 'How to get a GitHub Token:');
                title.style.marginBottom = '4px';

                const step1 = buildEl('div', '', '1. Open GitHub Token creation page:');
                const directLink = buildEl('a', 'text-primary font-bold hover:underline', '→ Click here to generate token (Auto-fills "gist" scope)');
                directLink.href = 'https://github.com/settings/tokens/new?description=MangaDex+Cloud&scopes=gist';
                directLink.target = '_blank';
                directLink.rel = 'noopener noreferrer';
                directLink.style.display = 'inline-block';
                directLink.style.margin = '3px 0 5px 0';

                const step2 = buildEl('div', '', '2. Set Expiration to "No expiration" and ensure the "gist" checkbox is ticked.');
                const step3 = buildEl('div', '', '3. Click "Generate token" at the bottom, copy the "ghp_..." code, and paste it below.');

                helpBox.appendChild(title);
                helpBox.appendChild(step1);
                helpBox.appendChild(directLink);
                helpBox.appendChild(step2);
                helpBox.appendChild(step3);
            });

            const tokenInput = buildEl('input', 'w-full bg-background text-color rounded border border-accent-20 outline-none focus:border-primary text-xs');
            tokenInput.style.padding = '9px 12px';
            tokenInput.style.marginBottom = '14px';
            tokenInput.type = 'password';
            tokenInput.placeholder = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
            if (authConfig && authConfig.token) tokenInput.value = authConfig.token;

            let gistActionsWrap = null;
            if (authConfig && authConfig.gistId) {
                gistActionsWrap = buildEl('div', 'flex items-center');
                gistActionsWrap.style.gap = '6px';

                const openGistLink = buildEl('a', 'text-xs font-bold text-primary rounded cursor-pointer hover:opacity-80 transition-opacity', 'Open Gist ↗');
                openGistLink.href = `https://gist.github.com/${authConfig.gistId}`;
                openGistLink.target = '_blank';
                openGistLink.rel = 'noopener noreferrer';
                openGistLink.style.padding = '2px 8px';
                openGistLink.style.fontSize = '0.68rem';
                openGistLink.style.backgroundColor = 'rgb(var(--md-primary) / 15%)';
                openGistLink.style.textDecoration = 'none';
                openGistLink.title = 'Open Gist database in a new tab';

                const copyGistBtn = buildEl('button', 'text-xs font-bold text-primary rounded cursor-pointer hover:opacity-80 transition-opacity', 'Copy ID');
                copyGistBtn.type = 'button';
                copyGistBtn.style.padding = '2px 8px';
                copyGistBtn.style.fontSize = '0.68rem';
                copyGistBtn.style.backgroundColor = 'rgb(var(--md-primary) / 15%)';
                copyGistBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(authConfig.gistId).then(() => {
                        copyGistBtn.textContent = 'Copied!';
                        setTimeout(() => { copyGistBtn.textContent = 'Copy ID'; }, 1500);
                    });
                });

                gistActionsWrap.appendChild(openGistLink);
                gistActionsWrap.appendChild(copyGistBtn);
            }

            const gistHeader = createLabelWithHelp('Gist ID (Optional for first setup):', (helpBox) => {
                const firstDev = buildEl('div', '');
                firstDev.style.marginBottom = '6px';
                firstDev.appendChild(buildEl('span', 'font-bold text-color', '• First Device Setup: '));
                firstDev.appendChild(buildEl('span', '', 'Leave this field empty! The script will automatically create a private Gist database in your GitHub account.'));

                const secondDev = buildEl('div', '');
                secondDev.appendChild(buildEl('span', 'font-bold text-primary', '• Syncing Other Devices (Important): '));
                secondDev.appendChild(buildEl('span', '', 'When setting up your second device (e.g. iPad or another PC), you MUST paste the exact same Gist ID here (e.g. 8f4a2b9c1d3e5f6a7b8c9d0e1f2a3b4c) so both devices share the same database. You can always copy your generated Gist ID by returning to this screen via "Change Token / Gist".'));

                helpBox.appendChild(firstDev);
                helpBox.appendChild(secondDev);
            }, gistActionsWrap);

            const gistInput = buildEl('input', 'w-full bg-background text-color rounded border border-accent-20 outline-none focus:border-primary text-xs');
            gistInput.style.padding = '9px 12px';
            gistInput.style.marginBottom = '14px';
            gistInput.type = 'text';
            gistInput.placeholder = 'Leave empty to auto-create, or paste existing Gist ID';
            if (authConfig && authConfig.gistId) gistInput.value = authConfig.gistId;

            const statusMsg = buildEl('div', 'text-xs font-bold');
            statusMsg.style.marginBottom = '10px';
            statusMsg.style.display = 'none';

            const cloudBtn = buildEl('button', 'w-full rounded bg-primary text-white text-xs font-bold hover:opacity-80 transition-opacity cursor-pointer', 'Connect / Create Cloud Database');
            cloudBtn.style.padding = '11px 16px';

            cloudBtn.addEventListener('click', async () => {
                const token = tokenInput.value.trim();
                const gistId = gistInput.value.trim();

                if (!token) {
                    statusMsg.style.display = 'block';
                    statusMsg.className = 'text-xs font-bold text-status-red';
                    statusMsg.textContent = 'Please enter a valid GitHub Token.';
                    return;
                }

                cloudBtn.disabled = true;
                cloudBtn.style.opacity = '0.5';
                cloudBtn.textContent = gistId ? 'Verifying Gist...' : 'Creating New Gist...';
                statusMsg.style.display = 'none';

                try {
                    if (gistId) {
                        const res = await fetch(`https://api.github.com/gists/${gistId}`, {
                            headers: {
                                'Authorization': `token ${token}`,
                                'Accept': 'application/vnd.github.v3+json'
                            }
                        });
                        if (!res.ok) throw new Error(`Gist not found or unauthorized (${res.status})`);

                        authConfig = { mode: 'cloud', token, gistId };
                        localStorage.setItem('md-cloud-auth', JSON.stringify(authConfig));
                        window.location.reload();
                    } else {
                        const backup = JSON.parse(localStorage.getItem('md-custom-data-backup')) || {};
                        const initialPayload = {
                            settings: settingsCache,
                            notes: backup.notes || notesCache || {},
                            ratings: backup.ratings || ratingsCache || {}
                        };

                        const res = await fetch('https://api.github.com/gists', {
                            method: 'POST',
                            headers: {
                                'Authorization': `token ${token}`,
                                'Accept': 'application/vnd.github.v3+json',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                description: 'MangaDex Cloud - Personal Notes & Ratings Database',
                                public: false,
                                files: {
                                    [GIST_FILENAME]: {
                                        content: JSON.stringify(initialPayload, null, 2)
                                    }
                                }
                            })
                        });

                        if (!res.ok) throw new Error(`Failed to create Gist (${res.status})`);
                        const data = await res.json();

                        authConfig = { mode: 'cloud', token, gistId: data.id };
                        localStorage.setItem('md-cloud-auth', JSON.stringify(authConfig));
                        window.location.reload();
                    }
                } catch (err) {
                    statusMsg.style.display = 'block';
                    statusMsg.className = 'text-xs font-bold text-status-red';
                    statusMsg.textContent = err.message;
                    cloudBtn.disabled = false;
                    cloudBtn.style.opacity = '1';
                    cloudBtn.textContent = 'Connect / Create Cloud Database';
                }
            });

            cloudSection.appendChild(tokenHeader);
            cloudSection.appendChild(tokenInput);
            cloudSection.appendChild(gistHeader);
            cloudSection.appendChild(gistInput);
            cloudSection.appendChild(statusMsg);
            cloudSection.appendChild(cloudBtn);
            box.appendChild(cloudSection);

            // Section 2: Local-Only Mode
            const localSection = buildEl('div', 'flex flex-col rounded-md border border-accent-20');
            localSection.style.padding = '16px';
            localSection.style.backgroundColor = 'rgb(var(--md-accent) / 30%)';

            const localHeader = buildEl('div', 'font-bold text-xs uppercase tracking-wider text-color', '2. Use Without Cloud (Local-Only Mode)');
            localHeader.style.marginBottom = '6px';

            const warningText = buildEl('p', 'text-xs text-midTone', 'If you do not use Cloud sync, all your ratings, rankings, and private notes are stored only inside this browser. Clearing your browser cache or site data will permanently wipe everything.');
            warningText.style.lineHeight = '1.45';
            warningText.style.marginBottom = '12px';

            const ackRow = buildEl('label', 'flex items-start cursor-pointer text-xs font-medium select-none');
            ackRow.style.gap = '10px';
            ackRow.style.marginBottom = '14px';

            const ackCheckbox = document.createElement('input');
            ackCheckbox.type = 'checkbox';
            ackCheckbox.style.marginTop = '2px';
            ackCheckbox.style.width = '16px';
            ackCheckbox.style.height = '16px';
            ackCheckbox.style.cursor = 'pointer';
            ackCheckbox.style.flexShrink = '0';

            const ackText = buildEl('span', '', 'I have read and understand that without Cloud sync my data may be permanently deleted. I do not want to use Cloud.');
            ackText.style.lineHeight = '1.4';
            ackRow.appendChild(ackCheckbox);
            ackRow.appendChild(ackText);

            const localBtn = buildEl('button', 'w-full rounded bg-accent-20 text-color text-xs font-bold transition-opacity opacity-40 cursor-not-allowed', 'Continue with Local Storage');
            localBtn.style.padding = '11px 16px';
            localBtn.disabled = true;

            ackCheckbox.addEventListener('change', () => {
                if (ackCheckbox.checked) {
                    localBtn.disabled = false;
                    localBtn.className = 'w-full rounded bg-accent-20 hover:bg-accent-30 text-color text-xs font-bold transition-colors cursor-pointer';
                } else {
                    localBtn.disabled = true;
                    localBtn.className = 'w-full rounded bg-accent-20 text-color text-xs font-bold transition-opacity opacity-40 cursor-not-allowed';
                }
            });

            localBtn.addEventListener('click', () => {
                if (!ackCheckbox.checked) return;
                authConfig = { mode: 'local', token: '', gistId: '' };
                localStorage.setItem('md-cloud-auth', JSON.stringify(authConfig));
                modal.style.display = 'none';
                notesCache = null;
                fetchNotes();
            });

            localSection.appendChild(localHeader);
            localSection.appendChild(warningText);
            localSection.appendChild(ackRow);
            localSection.appendChild(localBtn);
            box.appendChild(localSection);

            // Section 3: Wipe Local Data (Only shown after initial configuration)
            if (alreadyConfigured) {
                const wipeSection = createWipeDataComponent('3. Reset: Wipe All Local Data');
                wipeSection.style.marginTop = '14px';
                box.appendChild(wipeSection);
            }
        }

        modal.openOnboarding = () => {
            renderOnboarding();
            modal.style.display = 'flex';
            shade.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
            box.animate([{ opacity: 0, transform: 'scale(0.95)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 150, easing: 'ease-out' });
        };

        modal.appendChild(shade);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    // =========================================================================
    // SETTINGS MODAL (RESIZABLE, PROFILE MANAGER & PAGE MASTER TOGGLES)
    // =========================================================================
    function injectSettingsModal() {
        if (document.getElementById('md-custom-settings-modal')) return;

        const modal = buildEl('div', 'fixed inset-0');
        modal.id = 'md-custom-settings-modal';
        modal.style.zIndex = '9999';
        modal.style.display = 'none';

        const shade = buildEl('div', 'absolute inset-0');
        shade.id = 'md-custom-shade';
        shade.style.backgroundColor = 'rgba(0, 0, 0, 0.25)';

        const box = buildEl('div', 'absolute bg-background rounded-lg border border-accent-20 shadow-2xl flex flex-col text-color select-none overflow-hidden');
        box.id = 'md-custom-box';
        box.style.maxWidth = 'calc(100vw - 24px)';
        box.style.maxHeight = 'calc(100vh - 80px)';
        box.style.padding = '18px 20px';

        function applySavedDimensions() {
            const savedSize = JSON.parse(localStorage.getItem('md-custom-modal-size'));
            if (savedSize && savedSize.width) {
                box.style.width = Math.min(Math.max(savedSize.width, 320), window.innerWidth - 24) + 'px';
            } else {
                box.style.width = '400px';
            }

            if (savedSize && savedSize.height) {
                box.style.height = Math.min(Math.max(savedSize.height, 260), window.innerHeight - 80) + 'px';
            } else {
                box.style.height = '';
            }
        }

        function closeModal() {
            if (modal.style.display === 'none') return;
            shade.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'ease-in' });
            const boxAnim = box.animate([
                { opacity: 1, transform: 'scale(1)' },
                { opacity: 0, transform: 'scale(0.95)' }
            ], { duration: 150, easing: 'ease-in' });

            boxAnim.onfinish = () => {
                modal.style.display = 'none';
            };
        }

        shade.addEventListener('click', closeModal);

        function createDivider() {
            const hr = buildEl('hr', 'border-accent-20 shrink-0');
            hr.style.margin = '10px 0';
            return hr;
        }

        function createSwitchElement(initialValue, onChange) {
            let isChecked = Boolean(initialValue);

            const track = buildEl('div', 'relative rounded-full transition-colors duration-150 shrink-0 cursor-pointer');
            track.style.width = '36px';
            track.style.height = '20px';

            const thumb = buildEl('div', 'bg-white rounded-full shadow transition-transform duration-150');
            thumb.style.width = '16px';
            thumb.style.height = '16px';
            thumb.style.position = 'absolute';
            thumb.style.top = '2px';
            thumb.style.left = '2px';

            function updateVisual() {
                if (isChecked) {
                    track.classList.remove('bg-accent-20');
                    track.classList.add('bg-primary');
                    thumb.style.transform = 'translateX(16px)';
                } else {
                    track.classList.remove('bg-primary');
                    track.classList.add('bg-accent-20');
                    thumb.style.transform = 'translateX(0px)';
                }
            }
            updateVisual();
            track.appendChild(thumb);

            function toggle(e) {
                if (e) e.stopPropagation();
                isChecked = !isChecked;
                updateVisual();
                onChange(isChecked);
            }

            track.addEventListener('click', toggle);
            return { el: track, toggle };
        }

        function createCollapsibleSection(titleText, initialEnabled, onToggle) {
            const wrapper = buildEl('div', 'flex flex-col shrink-0');
            let isEnabled = Boolean(initialEnabled);

            const headerRow = buildEl('div', 'flex justify-between items-center rounded cursor-pointer hover:bg-accent transition-colors');
            headerRow.style.padding = '6px 8px';
            headerRow.style.marginBottom = '4px';

            const title = buildEl('span', 'font-bold text-primary text-xs uppercase tracking-wider', titleText);
            const statusBadge = buildEl('span', 'font-bold uppercase tracking-wider rounded transition-colors');
            statusBadge.style.fontSize = '0.68rem';
            statusBadge.style.padding = '3px 9px';

            const body = buildEl('div', 'flex flex-col');
            body.style.gap = '3px';

            function updateSectionState() {
                body.style.display = isEnabled ? 'flex' : 'none';
                title.style.opacity = isEnabled ? '1' : '0.45';
                if (isEnabled) {
                    statusBadge.textContent = 'ENABLED';
                    statusBadge.className = 'font-bold uppercase tracking-wider rounded text-primary';
                    statusBadge.style.backgroundColor = 'rgb(var(--md-primary) / 15%)';
                } else {
                    statusBadge.textContent = 'DISABLED';
                    statusBadge.className = 'font-bold uppercase tracking-wider rounded text-midTone';
                    statusBadge.style.backgroundColor = 'rgb(var(--md-accent-20) / 40%)';
                }
            }

            headerRow.addEventListener('click', () => {
                isEnabled = !isEnabled;
                updateSectionState();
                onToggle(isEnabled);
            });

            updateSectionState();

            headerRow.appendChild(title);
            headerRow.appendChild(statusBadge);
            wrapper.appendChild(headerRow);
            wrapper.appendChild(body);

            return { wrapper, body };
        }

        function createSwitchRow(labelText, initialValue, onChange) {
            const row = buildEl('div', 'flex justify-between items-center w-full rounded hover:bg-accent cursor-pointer transition-colors text-sm');
            row.style.padding = '6px 8px';

            const label = buildEl('span', 'font-medium', labelText);
            const sw = createSwitchElement(initialValue, onChange);

            row.addEventListener('click', (e) => {
                if (e.target !== sw.el && !sw.el.contains(e.target)) {
                    sw.toggle();
                }
            });

            row.appendChild(label);
            row.appendChild(sw.el);
            return row;
        }

        function createSegmentedRow(labelText, optionsArray, currentValue, onChange) {
            const row = buildEl('div', 'flex justify-between items-center w-full rounded text-sm');
            row.style.padding = '5px 8px';

            const label = buildEl('span', 'font-medium', labelText);

            const segContainer = buildEl('div', 'flex rounded-md bg-accent shrink-0');
            segContainer.style.padding = '4px';
            segContainer.style.gap = '4px';

            const buttons = {};

            optionsArray.forEach(opt => {
                const btn = buildEl('button', '', opt.label);
                btn.type = 'button';
                btn.style.padding = '5px 10px';
                btn.style.borderRadius = '4px';
                btn.style.fontSize = '0.7rem';

                function setActive(active) {
                    if (active) {
                        btn.className = 'font-bold uppercase transition-colors cursor-pointer bg-primary text-white shadow';
                    } else {
                        btn.className = 'font-bold uppercase transition-colors cursor-pointer text-midTone hover:text-color';
                    }
                }

                setActive(opt.value === currentValue);

                btn.addEventListener('click', () => {
                    Object.keys(buttons).forEach(k => buttons[k].setActive(k === opt.value));
                    onChange(opt.value);
                });

                buttons[opt.value] = { el: btn, setActive };
                segContainer.appendChild(btn);
            });

            row.appendChild(label);
            row.appendChild(segContainer);
            return row;
        }

        function createCornerSelector(labelText, currentValue, onChange) {
            const row = buildEl('div', 'flex justify-between items-center border-l-2 border-accent-20 transition-all');
            row.style.padding = '6px 8px 6px 16px';
            row.style.marginLeft = '8px';

            const label = buildEl('span', 'font-medium text-xs text-midTone', labelText);

            const grid = buildEl('div', 'grid grid-cols-2 grid-rows-2 rounded-md shrink-0 overflow-hidden border border-accent-20');
            grid.style.backgroundColor = 'rgb(var(--md-accent-20) / 40%)';
            grid.style.gap = '2px';
            grid.style.width = '38px';
            grid.style.height = '38px';

            const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
            const buttons = {};

            corners.forEach(corner => {
                const btn = buildEl('div', 'cursor-pointer transition-colors duration-150 w-full h-full');
                if (currentValue === corner) {
                    btn.classList.add('bg-primary');
                } else {
                    btn.classList.add('bg-background', 'hover:bg-accent');
                }

                btn.addEventListener('click', () => {
                    corners.forEach(c => {
                        buttons[c].classList.remove('bg-primary');
                        buttons[c].classList.add('bg-background', 'hover:bg-accent');
                    });
                    btn.classList.remove('bg-background', 'hover:bg-accent');
                    btn.classList.add('bg-primary');
                    onChange(corner);
                });
                buttons[corner] = btn;
                grid.appendChild(btn);
            });

            row.appendChild(label);
            row.appendChild(grid);

            return {
                element: row,
                updateVisibility: (pos) => { row.style.display = (pos === 'cover') ? 'flex' : 'none'; }
            };
        }

        function createCustomSyncInput(labelText, currentValue, onChange) {
            const row = buildEl('div', 'flex justify-between items-center border-l-2 border-accent-20 transition-all');
            row.style.padding = '6px 8px 6px 16px';
            row.style.marginLeft = '8px';

            const label = buildEl('span', 'font-medium text-xs text-midTone', labelText);

            const inputWrap = buildEl('div', 'flex items-center');
            inputWrap.style.gap = '6px';

            const input = buildEl('input', 'bg-accent text-color rounded border border-accent-20 outline-none focus:border-primary text-xs font-bold text-center');
            input.type = 'number';
            input.min = '1';
            input.max = '86400';
            input.value = currentValue || 60;
            input.style.width = '72px';
            input.style.padding = '5px 8px';

            const unitSpan = buildEl('span', 'text-xs text-midTone font-bold', 'sec');

            input.addEventListener('input', () => {
                const parsed = parseInt(input.value, 10);
                if (!isNaN(parsed) && parsed > 0) {
                    onChange(parsed);
                }
            });

            inputWrap.appendChild(input);
            inputWrap.appendChild(unitSpan);
            row.appendChild(label);
            row.appendChild(inputWrap);

            return {
                element: row,
                updateVisibility: (mode) => { row.style.display = (mode === 'custom') ? 'flex' : 'none'; }
            };
        }

        function createResizeHandle() {
            const handle = buildEl('div', 'absolute flex items-end justify-start text-midTone hover:text-primary transition-colors');
            handle.style.left = '0px';
            handle.style.bottom = '0px';
            handle.style.width = '22px';
            handle.style.height = '22px';
            handle.style.padding = '4px';
            handle.style.cursor = 'nesw-resize';
            handle.style.zIndex = '20';
            handle.style.touchAction = 'none';
            handle.title = 'Drag to resize (Double-click to reset)';

            const svgNS = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(svgNS, "svg");
            svg.setAttribute("width", "12");
            svg.setAttribute("height", "12");
            svg.setAttribute("viewBox", "0 0 12 12");
            svg.setAttribute("fill", "none");
            svg.setAttribute("stroke", "currentColor");
            svg.setAttribute("stroke-width", "1.75");
            svg.setAttribute("stroke-linecap", "round");

            const line1 = document.createElementNS(svgNS, "path");
            line1.setAttribute("d", "M1 4L8 11");
            const line2 = document.createElementNS(svgNS, "path");
            line2.setAttribute("d", "M1 8L4 11");

            svg.appendChild(line1);
            svg.appendChild(line2);
            handle.appendChild(svg);

            handle.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                handle.setPointerCapture(e.pointerId);

                const startX = e.clientX;
                const startY = e.clientY;
                const startWidth = box.offsetWidth;
                const startHeight = box.offsetHeight;

                function onPointerMove(moveEvent) {
                    const deltaX = startX - moveEvent.clientX;
                    const deltaY = moveEvent.clientY - startY;

                    const newWidth = Math.min(Math.max(320, startWidth + deltaX), window.innerWidth - 24);
                    const newHeight = Math.min(Math.max(260, startHeight + deltaY), window.innerHeight - 80);

                    box.style.width = newWidth + 'px';
                    box.style.height = newHeight + 'px';
                }

                function onPointerUp(upEvent) {
                    handle.releasePointerCapture(upEvent.pointerId);
                    handle.removeEventListener('pointermove', onPointerMove);
                    handle.removeEventListener('pointerup', onPointerUp);

                    localStorage.setItem('md-custom-modal-size', JSON.stringify({
                        width: box.offsetWidth,
                        height: box.offsetHeight
                    }));
                }

                handle.addEventListener('pointermove', onPointerMove);
                handle.addEventListener('pointerup', onPointerUp);
            });

            handle.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                localStorage.removeItem('md-custom-modal-size');
                applySavedDimensions();
            });

            return handle;
        }

        function renderModalContent(keepDrawerOpen = false) {
            while (box.firstChild) box.removeChild(box.firstChild);

            getActiveSettings();
            const draftAll = JSON.parse(JSON.stringify(settingsCache));
            const draft = draftAll[activeProfile];

            const headerDiv = buildEl('div', 'flex justify-between items-center border-b border-accent-20 shrink-0');
            headerDiv.style.padding = '0 8px 12px 8px';
            headerDiv.style.marginBottom = '10px';
            headerDiv.style.gap = '12px';

            const headerTitle = buildEl('span', 'font-bold text-lg shrink-0', isCloudMode() ? 'Cloud Settings' : 'Local Settings');
            headerTitle.style.whiteSpace = 'nowrap';

            const headerDevice = buildEl('div', 'flex items-center font-bold bg-primary text-white rounded uppercase tracking-wider cursor-pointer hover:opacity-80 transition-opacity select-none');
            headerDevice.style.padding = '5px 12px';
            headerDevice.style.fontSize = '0.78rem';
            headerDevice.style.minWidth = '0';
            headerDevice.style.maxWidth = '60%';
            headerDevice.title = activeProfile;

            const headerDeviceName = buildEl('span', '', activeProfile);
            headerDeviceName.style.overflow = 'hidden';
            headerDeviceName.style.textOverflow = 'ellipsis';
            headerDeviceName.style.whiteSpace = 'nowrap';

            const headerDeviceArrow = buildEl('span', 'shrink-0', '▾');
            headerDeviceArrow.style.marginLeft = '6px';

            headerDevice.appendChild(headerDeviceName);
            headerDevice.appendChild(headerDeviceArrow);

            headerDiv.appendChild(headerTitle);
            headerDiv.appendChild(headerDevice);
            box.appendChild(headerDiv);

            const content = buildEl('div', 'flex flex-col overflow-y-auto');
            content.style.overflowX = 'hidden';
            content.style.flex = '1 1 auto';
            content.style.minHeight = '0px';
            content.style.paddingRight = '2px';

            // Telemetry, Profile & Storage Drawer
            const drawerDiv = buildEl('div', 'flex-col rounded-md bg-accent shrink-0 border border-accent-20');
            drawerDiv.style.padding = '14px';
            drawerDiv.style.marginBottom = '14px';
            drawerDiv.style.display = keepDrawerOpen ? 'flex' : 'none';

            const statsRow = buildEl('div', 'flex justify-around items-center border-b border-accent-20');
            statsRow.style.paddingBottom = '12px';
            statsRow.style.marginBottom = '12px';

            const notesValueSpan = buildEl('span', 'text-primary font-bold text-base', Object.keys(notesCache || {}).length.toString());
            const ratingsValueSpan = buildEl('span', 'text-primary font-bold text-base', Object.keys(ratingsCache || {}).length.toString());

            const notesStat = buildEl('div', 'flex flex-col items-center w-1/2');
            notesStat.style.gap = '2px';
            notesStat.appendChild(buildEl('span', 'text-[0.625rem] text-midTone uppercase tracking-wider font-bold', 'Notes'));
            notesStat.appendChild(notesValueSpan);

            const divider = buildEl('div', 'w-px h-6 bg-accent-20 shrink-0');

            const ratingsStat = buildEl('div', 'flex flex-col items-center w-1/2');
            ratingsStat.style.gap = '2px';
            ratingsStat.appendChild(buildEl('span', 'text-[0.625rem] text-midTone uppercase tracking-wider font-bold', 'Ratings'));
            ratingsStat.appendChild(ratingsValueSpan);

            statsRow.appendChild(notesStat);
            statsRow.appendChild(divider);
            statsRow.appendChild(ratingsStat);
            drawerDiv.appendChild(statsRow);

            const profHeader = buildEl('div', 'flex justify-between items-center');
            profHeader.style.marginBottom = '10px';
            profHeader.appendChild(buildEl('span', 'text-xs text-midTone uppercase tracking-wider font-bold', 'Active Profile'));

            const addProfBtn = buildEl('button', 'text-xs font-bold text-primary rounded transition-opacity hover:opacity-80 cursor-pointer', '+ New Profile');
            addProfBtn.type = 'button';
            addProfBtn.style.padding = '5px 10px';
            addProfBtn.style.backgroundColor = 'rgb(var(--md-primary) / 15%)';
            addProfBtn.addEventListener('click', () => {
                const rawName = prompt('Enter new profile name (e.g. laptop, phone, work):');
                if (!rawName) return;
                const cleanName = rawName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
                if (!cleanName) return;

                if (!settingsCache[cleanName]) {
                    settingsCache[cleanName] = JSON.parse(JSON.stringify(draft));
                }
                activeProfile = cleanName;
                localStorage.setItem('md-active-profile', activeProfile);
                localStorage.setItem('md-custom-settings', JSON.stringify(settingsCache));
                markDirtyAndScheduleSave();
                renderModalContent(true);
            });
            profHeader.appendChild(addProfBtn);
            drawerDiv.appendChild(profHeader);

            const profList = buildEl('div', 'flex flex-wrap border-b border-accent-20');
            profList.style.gap = '8px';
            profList.style.paddingBottom = '14px';
            profList.style.marginBottom = '12px';

            const pillItems = [];

            Object.keys(draftAll).forEach((profKey, index) => {
                const isCurrent = (profKey === activeProfile);
                const pill = buildEl('div', 'rounded text-xs font-bold uppercase cursor-pointer transition-colors ' + (isCurrent ? 'bg-primary text-white shadow' : 'bg-background text-midTone hover:text-color border border-accent-20'));
                pill.style.display = 'grid';
                pill.style.gridTemplateColumns = '1fr minmax(0, auto) 1fr';
                pill.style.alignItems = 'center';
                pill.style.padding = '8px 10px';
                pill.style.minHeight = '36px';
                pill.style.minWidth = '0';
                pill.style.maxWidth = '100%';
                pill.style.boxSizing = 'border-box';
                pill.style.flex = '1 1 calc(50% - 4px)';

                // Left spacer to keep the profile name centered
                pill.appendChild(buildEl('div', ''));

                const nameSpan = buildEl('span', 'text-center', profKey);
                nameSpan.style.overflow = 'hidden';
                nameSpan.style.textOverflow = 'ellipsis';
                nameSpan.style.whiteSpace = 'nowrap';
                nameSpan.style.padding = '0 4px';
                pill.appendChild(nameSpan);

                const actionsWrap = buildEl('div', 'flex items-center justify-end shrink-0');
                actionsWrap.style.gap = '2px';
                actionsWrap.style.justifySelf = 'end';

                // Rename button
                const renBtn = buildEl('span', 'opacity-70 hover:opacity-100 font-bold', '✎');
                renBtn.style.padding = '2px 4px';
                renBtn.style.fontSize = '0.85rem';
                renBtn.title = 'Rename profile';
                renBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const rawNew = prompt(`Rename profile "${profKey}" to:`, profKey);
                    if (!rawNew) return;
                    const cleanNew = rawNew.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
                    if (!cleanNew || cleanNew === profKey) return;
                    if (settingsCache[cleanNew]) {
                        alert('A profile with this name already exists!');
                        return;
                    }

                    const updatedCache = {};
                    Object.keys(settingsCache).forEach(k => {
                        if (k === profKey) {
                            updatedCache[cleanNew] = (k === activeProfile) ? JSON.parse(JSON.stringify(draft)) : settingsCache[k];
                        } else {
                            updatedCache[k] = settingsCache[k];
                        }
                    });
                    settingsCache = updatedCache;

                    if (activeProfile === profKey) {
                        activeProfile = cleanNew;
                        localStorage.setItem('md-active-profile', activeProfile);
                    }
                    localStorage.setItem('md-custom-settings', JSON.stringify(settingsCache));
                    markDirtyAndScheduleSave();
                    renderModalContent(true);
                });
                actionsWrap.appendChild(renBtn);

                // Delete button (Never shown on index 0)
                if (index > 0) {
                    const delBtn = buildEl('span', 'opacity-70 hover:opacity-100 font-bold', '×');
                    delBtn.style.padding = '2px 5px';
                    delBtn.style.fontSize = '0.95rem';
                    delBtn.title = 'Delete profile';
                    delBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (!confirm(`Delete profile "${profKey}"?`)) return;
                        delete settingsCache[profKey];
                        if (activeProfile === profKey) {
                            activeProfile = Object.keys(settingsCache)[0];
                            localStorage.setItem('md-active-profile', activeProfile);
                        }
                        localStorage.setItem('md-custom-settings', JSON.stringify(settingsCache));
                        markDirtyAndScheduleSave();
                        renderModalContent(true);
                    });
                    actionsWrap.appendChild(delBtn);
                }

                pill.appendChild(actionsWrap);

                pill.addEventListener('click', () => {
                    if (profKey === activeProfile) return;
                    activeProfile = profKey;
                    localStorage.setItem('md-active-profile', activeProfile);
                    renderModalContent(true);
                });

                pillItems.push({ pill, nameSpan, actionsWrap });
                profList.appendChild(pill);
            });

            function updateProfileLayout() {
                const listWidth = profList.clientWidth;
                if (!listWidth) return;
                const halfInnerWidth = ((listWidth - 8) / 2) - 20;

                pillItems.forEach(({ pill, nameSpan, actionsWrap }) => {
                    const neededWidth = nameSpan.scrollWidth + actionsWrap.offsetWidth + 8;
                    const targetBasis = (neededWidth > halfInnerWidth) ? '100%' : 'calc(50% - 4px)';
                    if (pill.style.flexBasis !== targetBasis) {
                        pill.style.flexBasis = targetBasis;
                    }
                });
            }

            if (typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver(() => updateProfileLayout());
                ro.observe(profList);
            }

            drawerDiv.appendChild(profList);

            const storageRow = buildEl('div', 'flex justify-between items-center');
            storageRow.style.marginBottom = '10px';
            const modeLabel = buildEl('span', 'text-xs text-midTone uppercase tracking-wider font-bold', `Storage: ${isCloudMode() ? 'GitHub Cloud' : 'Local Only'}`);
            const configBtn = buildEl('button', 'text-xs font-bold text-primary rounded transition-opacity hover:opacity-80 cursor-pointer', isCloudMode() ? 'Change Token / Gist' : 'Setup Cloud Sync');
            configBtn.type = 'button';
            configBtn.style.padding = '5px 10px';
            configBtn.style.backgroundColor = 'rgb(var(--md-primary) / 15%)';
            configBtn.addEventListener('click', () => {
                modal.style.display = 'none';
                const obModal = document.getElementById('md-custom-onboarding-modal');
                if (obModal && typeof obModal.openOnboarding === 'function') {
                    obModal.openOnboarding();
                }
            });
            storageRow.appendChild(modeLabel);
            storageRow.appendChild(configBtn);
            drawerDiv.appendChild(storageRow);

            const wipeToggleRow = buildEl('div', 'flex justify-between items-center border-t border-accent-20');
            wipeToggleRow.style.paddingTop = '10px';
            const wipeLabel = buildEl('span', 'text-xs text-midTone uppercase tracking-wider font-bold', 'Browser Data');
            const wipeTriggerBtn = buildEl('button', 'text-xs font-bold text-status-red rounded transition-opacity hover:opacity-80 cursor-pointer', 'Wipe Local Data');
            wipeTriggerBtn.type = 'button';
            wipeTriggerBtn.style.padding = '5px 10px';
            wipeTriggerBtn.style.backgroundColor = 'rgb(var(--md-status-red) / 15%)';

            const wipeConfirmBox = createWipeDataComponent('Confirm Local Data Wipe');
            wipeConfirmBox.style.marginTop = '10px';
            wipeConfirmBox.style.display = 'none';

            wipeTriggerBtn.addEventListener('click', () => {
                const isHidden = wipeConfirmBox.style.display === 'none';
                if (isHidden) {
                    wipeConfirmBox.style.display = 'flex';
                    wipeConfirmBox.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 150, easing: 'ease-out' });
                } else {
                    wipeConfirmBox.style.display = 'none';
                }
            });

            wipeToggleRow.appendChild(wipeLabel);
            wipeToggleRow.appendChild(wipeTriggerBtn);
            drawerDiv.appendChild(wipeToggleRow);
            drawerDiv.appendChild(wipeConfirmBox);

            content.appendChild(drawerDiv);

            headerDevice.addEventListener('click', () => {
                if (drawerDiv.style.display === 'none') {
                    notesValueSpan.textContent = Object.keys(notesCache || {}).length.toString();
                    ratingsValueSpan.textContent = Object.keys(ratingsCache || {}).length.toString();
                    drawerDiv.style.display = 'flex';
                    drawerDiv.animate([{ opacity: 0, transform: 'scale(0.95)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 150, easing: 'ease-out' });
                } else {
                    const hideAnim = drawerDiv.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.95)' }], { duration: 150, easing: 'ease-in' });
                    hideAnim.onfinish = () => { drawerDiv.style.display = 'none'; };
                }
            });

            // Group 0: Cloud Auto-Sync
            if (isCloudMode()) {
                const syncHint = buildEl('div', 'rounded text-xs text-midTone');
                syncHint.style.padding = '6px 10px';
                syncHint.style.marginTop = '4px';
                syncHint.style.lineHeight = '1.35';
                syncHint.style.backgroundColor = 'rgb(var(--md-accent) / 45%)';

                function updateSyncHint() {
                    if (!draft.sync.enabled) {
                        syncHint.style.display = 'block';
                        syncHint.textContent = '⚠️ Manual Mode: Auto-sync is off. Click the cloud icon whenever the red dot appears to save to GitHub.';
                    } else if (draft.sync.mode === '4s') {
                        syncHint.style.display = 'none';
                    } else {
                        syncHint.style.display = 'block';
                        syncHint.textContent = '💡 Tip: Click the cloud icon (when the red dot is active) to sync immediately without waiting for the timer.';
                    }
                }

                const syncSec = createCollapsibleSection('Cloud Auto-Sync', draft.sync.enabled, (val) => {
                    draft.sync.enabled = val;
                    updateSyncHint();
                });

                const customSyncInput = createCustomSyncInput('Custom Delay', draft.sync.customSeconds, (val) => { draft.sync.customSeconds = val; });
                const syncModeRow = createSegmentedRow('Sync Delay', [
                    { label: '4s', value: '4s' },
                    { label: '1m', value: '1m' },
                    { label: '10m', value: '10m' },
                    { label: 'Custom', value: 'custom' }
                ], draft.sync.mode, (val) => {
                    draft.sync.mode = val;
                    customSyncInput.updateVisibility(val);
                    updateSyncHint();
                });

                syncSec.body.appendChild(syncModeRow);
                syncSec.body.appendChild(customSyncInput.element);
                customSyncInput.updateVisibility(draft.sync.mode);
                updateSyncHint();

                content.appendChild(syncSec.wrapper);
                content.appendChild(syncHint);
                content.appendChild(createDivider());
            }

            // Group 1: Title Page
            const titleSec = createCollapsibleSection('Title Page', draft.title.enabled, (val) => { draft.title.enabled = val; });
            titleSec.body.appendChild(createSwitchRow('Original Rating (x.xx)', draft.title.showOriginalRating, (val) => { draft.title.showOriginalRating = val; }));
            titleSec.body.appendChild(createSwitchRow('Title Page Rank (#)', draft.title.showRank, (val) => { draft.title.showRank = val; }));
            titleSec.body.appendChild(createSwitchRow('Private Notes', draft.title.showNotes, (val) => { draft.title.showNotes = val; }));
            content.appendChild(titleSec.wrapper);

            content.appendChild(createDivider());

            // Group 2: Home - Carousel
            const carSec = createCollapsibleSection('Home: Popular New Titles', draft.carousel.enabled, (val) => { draft.carousel.enabled = val; });
            const carCorner = createCornerSelector('Cover Corner', draft.carousel.corner, (val) => { draft.carousel.corner = val; });
            const carPosRow = createSegmentedRow('Carousel Rating Position', [
                { label: 'Cover', value: 'cover' },
                { label: 'Tags', value: 'tags' }
            ], draft.carousel.position, (val) => {
                draft.carousel.position = val;
                carCorner.updateVisibility(val);
            });
            carSec.body.appendChild(carPosRow);
            carSec.body.appendChild(carCorner.element);
            carCorner.updateVisibility(draft.carousel.position);
            carSec.body.appendChild(createSwitchRow('Carousel Rating Star', draft.carousel.showStar, (val) => { draft.carousel.showStar = val; }));
            carSec.body.appendChild(createSwitchRow('Carousel Rank (#)', draft.carousel.showRank, (val) => { draft.carousel.showRank = val; }));
            carSec.body.appendChild(createSwitchRow('Carousel Note', draft.carousel.showNote, (val) => { draft.carousel.showNote = val; }));
            content.appendChild(carSec.wrapper);

            content.appendChild(createDivider());

            // Group 3: Home - Latest Updates
            const latestSec = createCollapsibleSection('Home: Latest Updates', draft.latest.enabled, (val) => { draft.latest.enabled = val; });
            latestSec.body.appendChild(createSwitchRow('Latest Updates Rating Star', draft.latest.showStar, (val) => { draft.latest.showStar = val; }));
            content.appendChild(latestSec.wrapper);

            content.appendChild(createDivider());

            // Group 4: Feed & Lists
            const feedSec = createCollapsibleSection('Updates & Latest', draft.feed.enabled, (val) => { draft.feed.enabled = val; });
            const feedCorner = createCornerSelector('Cover Corner', draft.feed.corner, (val) => { draft.feed.corner = val; });
            const feedPosRow = createSegmentedRow('Feed Rating Position', [
                { label: 'Cover', value: 'cover' },
                { label: 'Flag', value: 'flag' },
                { label: 'Right', value: 'right' }
            ], draft.feed.position, (val) => {
                draft.feed.position = val;
                feedCorner.updateVisibility(val);
            });
            feedSec.body.appendChild(feedPosRow);
            feedSec.body.appendChild(feedCorner.element);
            feedCorner.updateVisibility(draft.feed.position);
            feedSec.body.appendChild(createSwitchRow('Rating Star', draft.feed.showStar, (val) => { draft.feed.showStar = val; }));
            content.appendChild(feedSec.wrapper);

            content.appendChild(createDivider());

            // Group 5: Search & Follows
            const searchSec = createCollapsibleSection('Advanced Search & Follows', draft.search.enabled, (val) => { draft.search.enabled = val; });
            searchSec.body.appendChild(createSegmentedRow('Original Ratings', [
                { label: 'On', value: 'on' },
                { label: 'No Follows', value: 'no-follows' },
                { label: 'Off', value: 'off' }
            ], draft.search.originalRatingMode, (val) => {
                draft.search.originalRatingMode = val;
            }));
            content.appendChild(searchSec.wrapper);

            content.appendChild(createDivider());

            // Group 6: Search Bar (Top Navbar Popup)
            const sbSec = createCollapsibleSection('Search Bar', draft.searchBar.enabled, (val) => { draft.searchBar.enabled = val; });
            sbSec.body.appendChild(createSwitchRow('Original Rating (x.xx)', draft.searchBar.showOriginalRating, (val) => { draft.searchBar.showOriginalRating = val; }));
            sbSec.body.appendChild(createSwitchRow('Search Bar Rank (#)', draft.searchBar.showRank, (val) => { draft.searchBar.showRank = val; }));
            content.appendChild(sbSec.wrapper);

            box.appendChild(content);

            const footer = buildEl('div', 'border-t border-accent-20 shrink-0');
            footer.style.marginTop = '14px';
            footer.style.paddingTop = '14px';

            const saveBtn = buildEl('button', 'w-full rounded-md bg-primary text-white font-bold hover:opacity-80 transition-opacity cursor-pointer', 'Save & Apply');
            saveBtn.style.padding = '10px 16px';

            saveBtn.addEventListener('click', async () => {
                settingsCache[activeProfile] = draft;
                localStorage.setItem('md-custom-settings', JSON.stringify(settingsCache));

                saveBtn.textContent = 'Saving...';
                saveBtn.style.opacity = '0.5';
                saveBtn.disabled = true;

                try {
                    await saveNotesToCloud();
                    modal.style.display = 'none';
                    window.location.reload();
                } catch (error) {
                    alert("Failed to save settings!");
                    saveBtn.textContent = 'Save & Apply';
                    saveBtn.style.opacity = '1';
                    saveBtn.disabled = false;
                }
            });

            footer.appendChild(saveBtn);
            box.appendChild(footer);

            box.appendChild(createResizeHandle());
        }

        modal.openModal = () => {
            applySavedDimensions();
            renderModalContent(false);

            const syncBtn = document.getElementById('md-custom-sync-btn');
            if (syncBtn) {
                const rect = syncBtn.getBoundingClientRect();
                box.style.top = (rect.bottom + 8) + 'px';
                box.style.right = Math.max(12, window.innerWidth - rect.right) + 'px';
            } else {
                box.style.top = '64px';
                box.style.right = '16px';
            }

            modal.style.display = 'block';
            shade.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
            box.animate([
                { opacity: 0, transform: 'scale(0.95)' },
                { opacity: 1, transform: 'scale(1)' }
            ], { duration: 150, easing: 'ease-out' });
        };

        modal.appendChild(shade);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    // =========================================================================
    // NAVBAR CLOUD ICON & ROUTER
    // =========================================================================
    function updateSyncIconUI() {
        const btn = document.getElementById('md-custom-sync-btn');
        const dot = document.getElementById('md-custom-sync-dot');
        const icon = document.querySelector('#md-custom-sync-btn svg');
        if (dot && icon) {
            if (!isConfigured()) {
                dot.style.display = 'block';
                dot.style.backgroundColor = 'rgb(218, 117, 0)';
                icon.style.opacity = '1';
                if (btn) btn.title = 'Setup Required: Click to configure MangaDex Cloud';
            } else if (hasFetchFailed) {
                dot.style.display = 'block';
                dot.style.backgroundColor = 'rgb(218, 117, 0)';
                icon.style.opacity = '1';
                if (btn) btn.title = 'Cloud Fetch Failed (Read-Only Backup Mode) - Click for Settings';
            } else if (isCloudMode() && isSaving) {
                dot.style.display = 'block';
                dot.style.backgroundColor = 'rgb(239, 68, 68)';
                icon.style.opacity = '1';
                if (btn) btn.title = 'Syncing changes to GitHub Cloud...';
            } else if (isCloudMode() && isDirty) {
                dot.style.display = 'block';
                dot.style.backgroundColor = 'rgb(239, 68, 68)';
                icon.style.opacity = '1';
                if (btn) btn.title = 'Unsaved changes! Click to sync to Cloud immediately';
            } else {
                dot.style.display = 'none';
                icon.style.opacity = '0.7';
                if (btn) btn.title = isCloudMode() ? 'Synced • Click to open Settings' : 'Click to open Local Settings';
            }
        }
    }

    function injectSyncIcon() {
        if (document.getElementById('md-custom-sync-btn')) return;

        const avatarBtn = document.getElementById('avatar');
        if (!avatarBtn) return;

        const navContainer = avatarBtn.parentElement;

        const syncBtn = document.createElement('button');
        syncBtn.id = 'md-custom-sync-btn';
        syncBtn.className = 'ml-2 md:ml-4 cursor-pointer bg-accent rounded-full flex items-center justify-center relative';
        syncBtn.style.minWidth = '40px';
        syncBtn.style.minHeight = '40px';
        syncBtn.title = 'MangaDex Cloud / Local Settings';

        const svgNS = "http://www.w3.org/2000/svg";
        const svgEl = document.createElementNS(svgNS, "svg");
        svgEl.setAttribute("width", "20");
        svgEl.setAttribute("height", "20");
        svgEl.setAttribute("fill", "none");
        svgEl.setAttribute("viewBox", "0 0 24 24");
        svgEl.setAttribute("stroke", "currentColor");
        svgEl.setAttribute("stroke-width", "2");
        svgEl.setAttribute("stroke-linecap", "round");
        svgEl.setAttribute("stroke-linejoin", "round");
        svgEl.setAttribute("class", "icon");
        svgEl.style.color = "currentcolor";
        svgEl.style.opacity = "0.7";

        const pathEl = document.createElementNS(svgNS, "path");
        pathEl.setAttribute("d", "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z");
        svgEl.appendChild(pathEl);

        const dotEl = document.createElement("span");
        dotEl.id = "md-custom-sync-dot";
        dotEl.style.display = "none";
        dotEl.style.position = "absolute";
        dotEl.style.top = "6px";
        dotEl.style.right = "6px";
        dotEl.style.width = "10px";
        dotEl.style.height = "10px";
        dotEl.style.backgroundColor = "rgb(239, 68, 68)";
        dotEl.style.borderRadius = "50%";
        dotEl.style.border = "2px solid var(--md-background)";

        syncBtn.appendChild(svgEl);
        syncBtn.appendChild(dotEl);

        navContainer.insertBefore(syncBtn, avatarBtn);
        updateSyncIconUI();

        syncBtn.addEventListener('click', () => {
            if (!isConfigured()) {
                const obModal = document.getElementById('md-custom-onboarding-modal');
                if (obModal && typeof obModal.openOnboarding === 'function') {
                    obModal.openOnboarding();
                }
                return;
            }

            if (isCloudMode() && isDirty && !hasFetchFailed) {
                syncBtn.style.opacity = '0.5';
                saveNotesToCloud().then(() => {
                    syncBtn.style.opacity = '1';
                });
            } else {
                const modal = document.getElementById('md-custom-settings-modal');
                if (modal && typeof modal.openModal === 'function') {
                    modal.openModal();
                }
            }
        });
    }

    function routeAndExecute() {
        const path = window.location.pathname;

        injectSyncIcon();
        injectOnboardingModal();
        injectSettingsModal();

        if (!isConfigured()) {
            const obModal = document.getElementById('md-custom-onboarding-modal');
            if (obModal && obModal.style.display === 'none') {
                obModal.openOnboarding();
            }
            return;
        }

        // Works globally on every page, including /chapter/ reading pages
        checkAndSaveNavbarSearchRatings();

        if (path.startsWith('/chapter/')) return;

        if (path.startsWith('/title/')) {
            if (notesCache === null) {
                fetchNotes();
            } else {
                injectUI();
                checkAndSaveRating();
            }
        } else if (path.startsWith('/titles/latest') || path.startsWith('/titles/feed')) {
            if (notesCache === null) {
                fetchNotes();
            } else {
                injectFeedRatings();
            }
        } else if (path === '/titles' || path === '/titles/follows' || path === '/titles/recent') {
            if (notesCache === null) {
                fetchNotes();
            } else {
                checkAndSaveSearchRatings();
            }
        } else if (path.startsWith('/titles/')) {
            return;
        } else if (path === '/') {
            if (notesCache === null) {
                fetchNotes();
            } else {
                injectCarouselUI();
                injectLatestUpdatesRatings();
            }
        }
    }

    let debounceTimer;
    const observer = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            routeAndExecute();
        }, 100);
    });

    const observerTarget = document.getElementById('app') || document.body;
    if (observerTarget) {
        observer.observe(observerTarget, { childList: true, subtree: true });
    }
    routeAndExecute();
})();
