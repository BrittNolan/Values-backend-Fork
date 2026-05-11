/* =============================================================
 * Values Lab — Organization Loader
 * =============================================================
 *
 * What this file does:
 * --------------------
 * This script transforms the generic Karabed Leadership Group
 * Values Lab into a customized, organization-branded experience.
 *
 * When someone visits Values Lab, they sign in with their
 * organization's username and password (the same credentials they
 * use to sign into the admin dashboard). After successful sign-in:
 *
 *   1. The organization's logo replaces the KLG logo
 *   2. The organization's brand colors replace the KLG navy/gold
 *   3. The organization's values are pre-loaded into Values Lab
 *      so staff don't have to type them in each time
 *   4. Each session saved to Supabase is tagged with the org's
 *      ID so the admin dashboard shows each org their own data
 *
 * What this file does NOT change:
 * -------------------------------
 *   - Any of the layout, animations, or features of Values Lab
 *   - Fast Mode, Detailed Mode, audio, PDF export, language toggle
 *   - The /api/analyze and /api/speak endpoints
 *
 * How it works at a technical level:
 * ----------------------------------
 *   - On page load, we replace the original KLG access-code login
 *     with a username/password login that talks to Supabase
 *   - After login, we read the org's row from the `orgs` table
 *     and apply the customization
 *   - We hook into the existing generate() function so each session
 *     is saved with the org_id
 * ============================================================= */

(function () {
  'use strict';

  // -----------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------
  // We get the Supabase credentials from the same /api/config
  // endpoint that admin.html uses, so there's nothing new to set up
  // on the backend.
  const CONFIG_ENDPOINT = '/api/config';

  // Session storage keys (cleared when browser closes)
  const SS_ORG = 'vl_org_v2';

  // Local storage keys used by the existing index.html for values.
  // We will overwrite these with the org's values on login.
  const LS_VALUES = 'vl_savedValues';
  const LS_SECTOR = 'vl_savedSector';
  const LS_TONE = 'vl_savedTone';

  let sb = null;          // Supabase client
  let currentOrg = null;  // The signed-in org (object with id, name, values, logo, colors)

  // ===== Language helpers =====
  // Read the current language (en or es) from the same place index.html stores it.
  function getCurrentLang() {
    try {
      const stored = localStorage.getItem('vl_lang');
      if (stored === 'es') return 'es';
    } catch(e) {}
    if (typeof window !== 'undefined' && window.currentLang === 'es') return 'es';
    return 'en';
  }

  // Get the value's display name in the current language. Falls back to English.
  function valueName(v) {
    if (typeof v === 'string') return v;
    if (!v) return '';
    const lang = getCurrentLang();
    if (lang === 'es' && v.name_es) return v.name_es;
    return v.name || '';
  }

  // Get the value's definition in the current language.
  function valueDefinition(v) {
    if (typeof v !== 'object' || !v) return '';
    const lang = getCurrentLang();
    if (lang === 'es' && v.definition_es) return v.definition_es;
    return v.definition || '';
  }


  // -----------------------------------------------------------
  // Boot: runs as soon as the page loads
  // -----------------------------------------------------------
  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    try {
      // Step 1: Get Supabase credentials from the existing endpoint
      const res = await fetch(CONFIG_ENDPOINT);
      const cfg = await res.json();
      sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

      // Step 2: Replace the original access-code login with our org login.
      // We always do this regardless of whether someone is already signed in,
      // because it's safer to always use the new login UI.
      installOrgLogin();

      // Step 3: If the user is already signed in (from a previous visit
      // in the same browser session), restore that org and skip login.
      const saved = sessionStorage.getItem(SS_ORG);
      if (saved) {
        try {
          currentOrg = JSON.parse(saved);
          applyOrgToPage(currentOrg);
          hideOrgLogin();
        } catch (e) {
          // If the saved org is corrupted, just clear it and show login
          sessionStorage.removeItem(SS_ORG);
        }
      }

      // Step 4: Hook into the existing generate function so that each
      // session is saved to Supabase with the correct org_id.
      installSessionLogger();

      // Step 5: Patch the rendered results so the "Behavior Observed"
      // shown in Detailed view is the user's verbatim text rather than
      // the AI's restatement (which can drift and add details the user
      // never wrote).
      installVerbatimBehaviorPatch();
    } catch (e) {
      console.error('Org loader failed to initialize:', e);
      // If we can't load Supabase config, fall back to the original
      // behavior so the app still works (just without org branding).
    }
  }

  // -----------------------------------------------------------
  // Login UI: replace the original access-code login
  // -----------------------------------------------------------
  function installOrgLogin() {
    // Find the original login overlay (the one asking for an access code)
    const orig = document.getElementById('login-overlay');
    if (!orig) return;

    // Replace its inner card with our new username/password card.
    // We keep the overlay container itself (with its dark navy background)
    // so the visual experience is consistent with the original.
    orig.innerHTML = `
      <div class="overlay-card" id="org-login-card">
        <div class="overlay-mark">
          <svg width="56" height="56" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="80" height="80" rx="16" fill="#1B2A4A"/>
            <rect x="12" y="12" width="56" height="56" stroke="#F7F5EF" stroke-width="1" fill="none" opacity="0.5"/>
            <rect x="31" y="12.5" width="18.33" height="55" fill="#C9A84C" opacity="0.18"/>
            <line x1="21" y1="21" x2="59" y2="59" stroke="#C9A84C" stroke-width="2.5" stroke-linecap="round"/>
            <circle cx="40" cy="40" r="4" fill="#C9A84C"/>
          </svg>
        </div>
        <div class="overlay-title">Values<em> Lab</em></div>
        <div class="overlay-sub">Organization sign in</div>

        <div class="login-field">
          <label for="org-login-username">Username</label>
          <input type="text" class="values-input" id="org-login-username"
                 placeholder="e.g. lifemoves" autocomplete="username" />
        </div>

        <div class="login-field">
          <label for="org-login-password">Password</label>
          <input type="password" class="values-input" id="org-login-password"
                 placeholder="Enter your password" autocomplete="current-password" />
        </div>

        <div class="login-error" id="org-login-error"></div>

        <button class="btn-primary" id="org-login-btn"
                style="margin-top:1rem;">Continue</button>

        <div class="overlay-footer">
          Need an account? Contact Karabed Leadership Group.
        </div>
      </div>
    `;

    // Make sure the overlay is visible (the original code might have hidden
    // it if a previous session set the old vl_authed flag — we ignore that)
    orig.style.display = 'flex';

    // Wire up the buttons and Enter key
    const btn = document.getElementById('org-login-btn');
    const userInput = document.getElementById('org-login-username');
    const passInput = document.getElementById('org-login-password');

    btn.addEventListener('click', attemptOrgLogin);
    passInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); attemptOrgLogin(); }
    });
    userInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); passInput.focus(); }
    });
  }

  function hideOrgLogin() {
    const orig = document.getElementById('login-overlay');
    if (orig) orig.style.display = 'none';
  }

  async function attemptOrgLogin() {
    const username = (document.getElementById('org-login-username').value || '').trim().toLowerCase();
    const password = (document.getElementById('org-login-password').value || '').trim();
    const errEl = document.getElementById('org-login-error');
    const btn = document.getElementById('org-login-btn');

    errEl.style.display = 'none';

    if (!username || !password) {
      showLoginError('Please enter both username and password.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Signing in...';

    try {
      // Look up the org by username + password.
      // We select all the columns we need to customize the page.
      const { data, error } = await sb
        .from('orgs')
        .select('id, name, username, values, logo_url, primary_color, accent_color')
        .eq('username', username)
        .eq('password', password)
        .single();

      if (error || !data) {
        showLoginError('Incorrect username or password. Please try again.');
        return;
      }

      currentOrg = data;
      sessionStorage.setItem(SS_ORG, JSON.stringify(data));
      applyOrgToPage(data);
      hideOrgLogin();

    } catch (e) {
      console.error('Login error:', e);
      showLoginError('Connection error. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Continue';
    }
  }

  function showLoginError(msg) {
    const errEl = document.getElementById('org-login-error');
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  // -----------------------------------------------------------
  // Apply the org's branding to the page
  // -----------------------------------------------------------
  function applyOrgToPage(org) {
    // 1. Apply brand colors by overriding the CSS variables
    applyBrandColors(org.primary_color, org.accent_color);

    // 2. Replace the logo image at the top of the page
    applyLogo(org.logo_url, org.name);

    // 3. Pre-populate the org's values into local storage so Fast Mode
    //    skips the values-setup step. We store just the value names
    //    (which is what the existing app expects).
    if (Array.isArray(org.values) && org.values.length) {
      const valueNames = org.values.map(function (v) {
        // Database values may be { name, definition, name_es, definition_es }
        // Pick the language-appropriate name.
        return valueName(v);
      });
      localStorage.setItem(LS_VALUES, JSON.stringify(valueNames));

      // Also push the values straight into the in-memory state of the
      // existing app. This is important because Fast Mode runs its
      // "do I have saved values?" check ONCE on page load, before our
      // login completes. If we don't re-trigger it here, Fast Mode will
      // still show the one-time setup screen even though the values are
      // now in storage. So we re-render Fast Mode if it's the active mode.
      try {
        if (typeof window.orgValues !== 'undefined') {
          window.orgValues = valueNames;
        }
        if (typeof renderFastValuesBar === 'function') {
          renderFastValuesBar();
        }
        // Also pre-fill the Detailed Mode values input, in case the user
        // switches there. This matches what switchMode('detailed') does
        // when there are stored values, but applied immediately.
        const detailedValuesInput = document.getElementById('f-values');
        if (detailedValuesInput) {
          detailedValuesInput.value = valueNames.join(', ');
          detailedValuesInput.dispatchEvent(new Event('input'));
        }
      } catch (e) {
        console.warn('Could not re-render Fast Mode values bar:', e);
      }
    }

    // 4. Update the page title and any "Karabed Leadership Group"
    //    text that should reflect the current org instead.
    const orgPill = document.createElement('div');
    orgPill.id = 'org-pill';
    orgPill.style.cssText = `
      position: fixed;
      top: 14px;
      right: 14px;
      z-index: 50;
      background: rgba(255,255,255,0.92);
      color: ${org.primary_color || '#1B2A4A'};
      border: 1px solid rgba(0,0,0,0.1);
      border-radius: 999px;
      padding: 6px 14px 6px 12px;
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.04em;
      display: flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    `;
    orgPill.innerHTML = `
      <span style="opacity:0.6;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;">Signed in as</span>
      <span style="font-weight:600;">${escapeHtml(org.name)}</span>
      <a href="#" id="org-signout-link"
         style="margin-left:6px;color:inherit;opacity:0.55;text-decoration:underline;font-size:11px;">
        Sign out
      </a>
    `;
    // Remove any existing pill (e.g. if applyOrgToPage runs twice)
    const existing = document.getElementById('org-pill');
    if (existing) existing.remove();
    document.body.appendChild(orgPill);

    document.getElementById('org-signout-link').addEventListener('click', function (e) {
      e.preventDefault();
      signOut();
    });

    // 5. Make the values definitions available so leadership can see
    //    them. We add a small "View values & definitions" link next
    //    to the saved-values bar in Fast Mode (if present).
    addValuesDefinitionsLink(org.values);
  }

  function applyBrandColors(primary, accent) {
    if (!primary && !accent) return;

    // Inject a style tag that overrides the brand colors site-wide.
    // We target the most visible places: hero background, primary
    // buttons, value chips, mode switcher, and accent highlights.
    const style = document.createElement('style');
    style.id = 'org-brand-overrides';

    const p = primary || '#1B2A4A';
    const a = accent || '#C9A84C';

    style.textContent = `
      /* Org brand color overrides */
      .hero { background: ${p} !important; }
      .btn-primary { background: ${p} !important; color: ${a} !important; }
      .btn-primary:hover { background: ${darken(p)} !important; }
      .mode-btn.active { background: ${p} !important; color: ${a} !important; }
      .value-chip,
      .fast-value-chip,
      .vtag {
        background: ${p} !important;
        color: ${a} !important;
      }
      .preset-pill:hover,
      .sector-pill:hover { background: ${p} !important; color: ${a} !important; border-color: ${p} !important; }
      .sector-pill.selected,
      .tone-pill.selected,
      .segment-option.selected {
        background: ${p} !important; color: ${a} !important; border-color: ${p} !important;
      }
      .qv-card.script { background: ${p} !important; }
      .qv-card.script .qv-card-label,
      .qv-card.script .qv-card-dot { color: ${a} !important; background: ${a} !important; }
      .progress-step.active .progress-num { background: ${p} !important; color: ${a} !important; border-color: ${p} !important; }
      .progress-step.complete .progress-num { background: ${a} !important; color: ${p} !important; border-color: ${a} !important; }
      .audio-player { background: ${p} !important; }
      .audio-play-btn { background: ${a} !important; color: ${p} !important; }
      .footer strong { color: ${a} !important; }
      .lab { color: ${a} !important; }
      .qv-action-banner.coach .qv-action-chip { background: ${p} !important; color: ${a} !important; }
      .lang-btn { color: ${a} !important; border-color: ${a} !important; }
      .lang-btn:hover { background: ${a}22 !important; }
      .text-size-btn.active { background: ${a} !important; color: ${p} !important; }
      .text-size-btn { color: ${a} !important; }
      .text-size-toggle { border-color: ${a} !important; }
    `;
    // Remove any existing override before adding the new one
    const existing = document.getElementById('org-brand-overrides');
    if (existing) existing.remove();
    document.head.appendChild(style);
  }

  function applyLogo(logoUrl, orgName) {
    const mark = document.querySelector('.hero .hero-mark');

    // Case 1: org has its own logo image — replace the Values Lab mark with it
    if (logoUrl && mark) {
      mark.innerHTML = `<img src="${escapeAttr(logoUrl)}" alt="${escapeAttr(orgName || 'Organization logo')}"
        style="max-height:72px;max-width:280px;object-fit:contain;background:white;padding:10px 16px;border-radius:8px;" />`;
    }

    // Case 2: regardless of whether they have a custom logo, show the org name
    // prominently in the hero. We add a styled badge OVERLAY directly on top
    // of the Values Lab mark so the org instantly knows this is THEIR space.
    if (orgName && mark && !document.getElementById('org-name-overlay')) {
      const overlay = document.createElement('div');
      overlay.id = 'org-name-overlay';
      overlay.textContent = orgName;
      overlay.style.cssText = [
        'display:inline-block',
        'margin-top:14px',
        'padding:8px 18px',
        'background:rgba(255,255,255,0.08)',
        'color:#C9A84C',
        'border:1px solid rgba(201,168,76,0.4)',
        'border-radius:999px',
        'font-family:\'Playfair Display\', Georgia, serif',
        'font-size:18px',
        'font-weight:500',
        'letter-spacing:0.02em',
        'text-align:center'
      ].join(';');
      // Insert it right after the hero-mark element so it sits below the logo
      mark.insertAdjacentElement('afterend', overlay);
    }

    // Also swap the wordmark text "Values Lab" byline to mention the org
    const byline = document.querySelector('.hero .byline');
    if (byline && orgName) byline.textContent = orgName;
  }

  function addValuesDefinitionsLink(values) {
    if (!Array.isArray(values) || !values.length) return;

    // We make two passes:
    //  - One immediately, in case the elements are already in the DOM
    //  - One after a short delay, to catch elements that get inserted/changed
    //    when the user navigates between modes or finishes a session
    swapEditForDefinitionsButtons(values);
    setTimeout(function () { swapEditForDefinitionsButtons(values); }, 500);
    setTimeout(function () { swapEditForDefinitionsButtons(values); }, 1500);

    // Also watch for DOM changes (like the results screen appearing) so we
    // can swap the buttons when those new elements show up.
    const observer = new MutationObserver(function () {
      swapEditForDefinitionsButtons(values);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function swapEditForDefinitionsButtons(values) {
    // ---- Saved-values bar at the top of Fast Mode ----
    // Original button calls editSavedValues() which jumps to Detailed Mode.
    // For org users, we hide it and add a "View definitions" button instead.
    const editTopBtn = document.getElementById('fast-edit-btn');
    if (editTopBtn && editTopBtn.style.display !== 'none') {
      editTopBtn.style.display = 'none';
    }
    const valuesBar = document.getElementById('fast-values-bar');
    if (valuesBar && !document.getElementById('org-defs-link-top')) {
      const link = document.createElement('button');
      link.id = 'org-defs-link-top';
      link.type = 'button';
      link.className = 'fast-edit-link';
      link.textContent = getCurrentLang() === 'es' ? 'Ver definiciones' : 'View definitions';
      link.addEventListener('click', function () { showDefinitionsModal(values); });
      valuesBar.appendChild(link);
    }

    // ---- Results action bar (Fast Mode results screen) ----
    // Original button is "Edit my values" with id btn-edit-values.
    // We hide it and add a "View definitions" button next to it.
    const editResultsBtn = document.getElementById('btn-edit-values');
    if (editResultsBtn && editResultsBtn.style.display !== 'none') {
      editResultsBtn.style.display = 'none';

      // Add a replacement button right where the old one was
      if (!document.getElementById('btn-view-defs-results')) {
        const btn = document.createElement('button');
        btn.id = 'btn-view-defs-results';
        btn.type = 'button';
        btn.className = 'fast-action-btn';
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
          </svg>
          <span>${getCurrentLang() === 'es' ? 'Ver definiciones' : 'View definitions'}</span>
        `;
        btn.addEventListener('click', function () { showDefinitionsModal(values); });
        editResultsBtn.insertAdjacentElement('afterend', btn);
      }
    }

    // ---- Add an "Edit behavior" button to the results action bar ----
    // This lets the user go back to the input screen with their behavior
    // text and pattern selection pre-filled, so they can refine the scenario
    // without typing it all over again.
    const newSituationBtn = document.getElementById('btn-new-situation');
    if (newSituationBtn && !document.getElementById('btn-edit-behavior')) {
      const editBtn = document.createElement('button');
      editBtn.id = 'btn-edit-behavior';
      editBtn.type = 'button';
      editBtn.className = 'fast-action-btn';
      editBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9"/>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
        <span>Edit behavior</span>
      `;
      editBtn.addEventListener('click', editBehavior);
      // Insert it right after the "New situation" button
      newSituationBtn.insertAdjacentElement('afterend', editBtn);
    }
  }

  // -----------------------------------------------------------
  // Edit behavior: take the user back to the input screen
  // with their original behavior and pattern pre-filled
  // -----------------------------------------------------------
  function editBehavior() {
    try {
      // Stop any audio that might be playing
      if (typeof currentAudio !== 'undefined' && currentAudio) {
        currentAudio.pause();
      }

      // Capture the original situation text and pattern.
      // The existing app stores the original situation on window.lastSituation
      // and the pattern in either fastSelectedPattern or selectedPattern.
      const originalText = (typeof window.lastSituation === 'string')
        ? window.lastSituation
        : (document.getElementById('f-situation')
            ? document.getElementById('f-situation').value
            : '');
      const originalPattern = (typeof window.fastSelectedPattern === 'string' && window.fastSelectedPattern)
        ? window.fastSelectedPattern
        : ((typeof window.selectedPattern === 'string' && window.selectedPattern)
            ? window.selectedPattern
            : 'first');

      // Hide the results screen
      const resultsView = document.getElementById('results-view');
      if (resultsView) resultsView.style.display = 'none';
      document.body.classList.remove('fast-results');
      document.body.classList.remove('detailed-results');

      // Reset the audio UI to its initial state
      const audioPlayer = document.getElementById('audio-player');
      if (audioPlayer) audioPlayer.classList.remove('visible');
      const playIcon = document.getElementById('play-icon');
      const pauseIcon = document.getElementById('pause-icon');
      if (playIcon) playIcon.style.display = 'block';
      if (pauseIcon) pauseIcon.style.display = 'none';

      // Switch back to Fast Mode and pre-fill the textarea
      if (typeof window.switchMode === 'function') {
        window.switchMode('fast');
      }

      const fastTextarea = document.getElementById('fast-f-situation');
      if (fastTextarea) {
        fastTextarea.value = originalText;
        // Place the cursor at the end so the user can continue typing
        fastTextarea.focus();
        const len = fastTextarea.value.length;
        try { fastTextarea.setSelectionRange(len, len); } catch (e) { /* ignore */ }
      }

      // Restore the pattern selection in the Fast Mode pattern segmented control
      if (typeof window.selectFastPattern === 'function') {
        window.selectFastPattern(originalPattern);
      }

      // Smooth scroll up so the user lands on the input
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      console.warn('editBehavior failed:', e);
    }
  }


  function showDefinitionsModal(values) {
    // Simple modal showing each value with its definition
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(20,28,48,0.6);
      display: flex; align-items: center; justify-content: center;
      z-index: 99999; padding: 1.5rem;
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      background: white; border-radius: 14px; max-width: 640px;
      width: 100%; max-height: 86vh; overflow-y: auto;
      padding: 2rem 2rem 1.5rem;
      font-family: 'DM Sans', sans-serif;
    `;

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1.5rem;">
        <div>
          <div style="font-size:10px;font-weight:600;color:#A88835;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:6px;">
            ${escapeHtml(currentOrg && currentOrg.name ? currentOrg.name : 'Organization')} Values
          </div>
          <div style="font-family:'Playfair Display',serif;font-size:24px;font-weight:600;color:#1a1a17;">
            ${getCurrentLang() === 'es' ? 'Nuestros valores, en nuestras palabras' : 'Our values, in our words'}
          </div>
        </div>
        <button id="defs-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:#888;line-height:1;">×</button>
      </div>
    `;

    values.forEach(function (v) {
      const name = valueName(v);
      const def = valueDefinition(v);
      html += `
        <div style="padding:14px 0;border-bottom:1px solid #eee;">
          <div style="font-weight:600;color:#1a1a17;font-size:15px;margin-bottom:4px;">${escapeHtml(name)}</div>
          ${def ? `<div style="color:#4a4843;font-size:13.5px;line-height:1.6;font-weight:300;">${escapeHtml(def)}</div>` : ''}
        </div>
      `;
    });

    card.innerHTML = html;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function close() { overlay.remove(); }
    document.getElementById('defs-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
  }

  function signOut() {
    sessionStorage.removeItem(SS_ORG);
    // Also clear the values cache so the next user doesn't see the prior org's values
    localStorage.removeItem(LS_VALUES);
    location.reload();
  }

  // -----------------------------------------------------------
  // Session logging: tag each session with the org_id
  // -----------------------------------------------------------
  function installSessionLogger() {
    // The original index.html POSTs to /api/analyze and gets back
    // a result object. To save sessions to Supabase tagged with the
    // org_id, we wrap the global fetch so that when /api/analyze
    // returns successfully, we also write a row to the sessions table.
   const originalFetch = window.fetch;
    window.fetch = async function (input, init) {
      // Inject org_id into /api/analyze requests so the backend can look up the right handbook
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/api/analyze') && currentOrg && init && init.body) {
          const body = JSON.parse(init.body);
          if (!body.orgId) {
            body.orgId = currentOrg.id;
            init.body = JSON.stringify(body);
          }
        }
      } catch (e) { /* ignore - request will proceed without org_id */ }

      const response = await originalFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/api/analyze') && response.ok && currentOrg && sb) {
          // Clone the response so we can read it without consuming it
          // for the original caller.
          const cloned = response.clone();
          const data = await cloned.json();
          // Pull the situation text out of the request body
          let behavior = '';
          let pattern = '';
          try {
            if (init && init.body) {
              const body = JSON.parse(init.body);
              behavior = body.situation || '';
              pattern = body.pattern || '';
            }
          } catch (e) { /* ignore */ }

          const misaligned = (data.valuesAnalysis || [])
            .filter(function (v) { return v.status === 'Misaligned'; })
            .map(function (v) { return v.value; });
          const upheld = (data.valuesAnalysis || [])
            .filter(function (v) { return v.status === 'Upheld'; })
            .map(function (v) { return v.value; });

          // Fire and forget — we don't want to block the UI
          sb.from('sessions').insert({
            org_id: currentOrg.id,
            behavior: behavior,
            pattern: pattern,
            misaligned_values: misaligned,
            upheld_values: upheld,
            recommended_action: data.recommendedAction ? data.recommendedAction.action : null,
            result_json: data
          }).then(function (res) {
            if (res.error) console.warn('Session log failed:', res.error);
          });
        }
      } catch (e) {
        console.warn('Session logger error:', e);
      }
      return response;
    };
  }

  // -----------------------------------------------------------
  // Verbatim behavior patch: replace the AI's restatement of the
  // user's behavior with the user's actual words. This applies to:
  //   1. The "Behavior Observed" field in Detailed view
  //   2. The PDF download
  // We do this because LLMs sometimes embellish or invent details
  // when restating, and we want the displayed behavior to be a
  // faithful record of what the user actually wrote.
  // -----------------------------------------------------------
  function installVerbatimBehaviorPatch() {
    // Watch the DOM for the results card to be updated. When we see the
    // "Behavior Observed" section appear, swap its content for the user's
    // verbatim text (window.lastSituation).
    const observer = new MutationObserver(function () {
      patchBehaviorObservedInDetailedView();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Also patch the PDF generator so the printed document uses the user's
    // verbatim text in the Behavior Observed section. We do this by wrapping
    // the original downloadPDF function once it becomes available.
    let pdfPatched = false;
    const tryPatchPDF = function () {
      if (pdfPatched) return;
      if (typeof window.downloadPDF !== 'function') return;
      const originalDownload = window.downloadPDF;
      window.downloadPDF = function () {
        // Briefly inject the user's verbatim text into lastResult so the
        // PDF builder picks it up, then restore the original AI value
        // afterward so nothing else in the app sees the change.
        const verbatim = (typeof window.lastSituation === 'string' && window.lastSituation)
          ? window.lastSituation : null;
        if (verbatim && window.lastResult && typeof window.lastResult === 'object') {
          const original = window.lastResult.behaviorObserved;
          window.lastResult.behaviorObserved = verbatim;
          try { originalDownload.apply(this, arguments); }
          finally { window.lastResult.behaviorObserved = original; }
        } else {
          return originalDownload.apply(this, arguments);
        }
      };
      pdfPatched = true;
    };
    // The downloadPDF function is defined inline in index.html so it should
    // already exist by the time we boot, but we also retry briefly in case.
    tryPatchPDF();
    setTimeout(tryPatchPDF, 250);
    setTimeout(tryPatchPDF, 1000);
  }

  function patchBehaviorObservedInDetailedView() {
    // The verbatim text the user actually typed
    const verbatim = (typeof window.lastSituation === 'string' && window.lastSituation)
      ? window.lastSituation : null;
    if (!verbatim) return;

    // The Detailed view is rendered inside #full-analysis. The first
    // r-section in there is "Behavior Observed" with a <p class="content">
    // showing the AI's restatement. We replace its text with the verbatim.
    const fullAnalysis = document.getElementById('full-analysis');
    if (!fullAnalysis) return;

    // Look at the first .r-section inside the full analysis
    const firstSection = fullAnalysis.querySelector('.r-section');
    if (!firstSection) return;
    const para = firstSection.querySelector('p.content');
    if (!para) return;

    // Only replace if it's currently showing the AI version (so we don't
    // overwrite repeatedly). We mark it once we've replaced it.
    if (para.getAttribute('data-verbatim-applied') === '1') return;
    para.textContent = verbatim;
    para.setAttribute('data-verbatim-applied', '1');
    // Add a small italic style cue so the user sees this is their own text
    para.style.fontStyle = 'italic';

    // Once we've patched the verbatim text, also reorder the sections so
    // "What may be going on for this staff member" appears right after
    // "Behavior Observed" instead of being buried further down. This puts
    // the human-context lens up front, which matches a trauma-informed
    // coaching flow.
    reorderDetailedViewSections(fullAnalysis);

    // Then inject the "What may be going on for you" (manager reflection)
    // section so it appears right after the staff reality section. This
    // mirrors the parallel structure of looking at both lenses together.
    injectManagerReflectionSection(fullAnalysis);
  }

  function reorderDetailedViewSections(fullAnalysis) {
    // Don't reorder twice
    if (fullAnalysis.getAttribute('data-reordered') === '1') return;

    // The "Full Leadership Tool" wrapper holds all the r-section blocks
    // and r-divider blocks. We need to find the section whose label
    // starts with "What may" (English) or "La posible" (Spanish), and
    // move it up to right after the first section.
    const toolSection = fullAnalysis.querySelector('.tool-section.full-tool');
    if (!toolSection) return;

    const sections = Array.from(toolSection.querySelectorAll('.r-section'));
    // Find the staff-reality section by looking for an .r-section that
    // contains a .staff-reality element (most reliable selector).
    let staffSectionIndex = -1;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].querySelector('.staff-reality')) {
        staffSectionIndex = i;
        break;
      }
    }
    if (staffSectionIndex === -1) return;
    // If it's already in position 1 (right after Behavior Observed), we're done
    if (staffSectionIndex === 1) {
      fullAnalysis.setAttribute('data-reordered', '1');
      return;
    }

    const staffSection = sections[staffSectionIndex];
    // The divider that sits right before this section in the DOM
    const dividerBefore = staffSection.previousElementSibling;
    // We want to move both the section and a divider together, to keep
    // the visual rhythm consistent with the rest of the page.

    // Insert the staff section right after the first (Behavior Observed) section
    const firstSection = sections[0];
    const firstDivider = firstSection.nextElementSibling; // the divider after Behavior Observed

    // Move staffSection so it sits right after the firstDivider
    // (so order becomes: Behavior Observed, divider, Staff Reality, divider, ...)
    if (firstDivider && firstDivider.classList.contains('r-divider')) {
      // First, remove the staff section and the divider that was before it
      // (so we don't leave a stray divider behind in the original spot).
      if (dividerBefore && dividerBefore.classList.contains('r-divider')) {
        dividerBefore.remove();
      }
      staffSection.remove();

      // Now insert it after the firstDivider
      firstDivider.insertAdjacentElement('afterend', staffSection);
      // And add a new divider right after it so the next section is separated
      const newDivider = document.createElement('div');
      newDivider.className = 'r-divider';
      staffSection.insertAdjacentElement('afterend', newDivider);
    }

    fullAnalysis.setAttribute('data-reordered', '1');
  }

  function injectManagerReflectionSection(fullAnalysis) {
    // Don't inject twice on the same render
    if (fullAnalysis.getAttribute('data-reflection-injected') === '1') return;

    // We need the AI's response (lastResult) to find the managerReflection field.
    // If it's not present (because the index.html prompt patch hasn't been
    // applied yet, or because the AI didn't return it for some reason), we
    // gracefully skip. The page still works exactly as before.
    const result = window.lastResult;
    if (!result || typeof result !== 'object') return;
    const reflection = result.managerReflection;
    if (!reflection || typeof reflection !== 'string' || reflection.trim().length === 0) return;

    // Find the staff reality section so we can place the new section right after it
    const toolSection = fullAnalysis.querySelector('.tool-section.full-tool');
    if (!toolSection) return;
    const staffRealityEl = toolSection.querySelector('.staff-reality');
    if (!staffRealityEl) return;
    const staffSection = staffRealityEl.closest('.r-section');
    if (!staffSection) return;
    // The divider that comes right after the staff section
    const dividerAfterStaff = staffSection.nextElementSibling;

    // Pick the right label based on current language
    const currentLang = (typeof window.currentLang === 'string') ? window.currentLang : 'en';
    const sectionLabel = currentLang === 'es'
      ? 'Lo que puede estar pasando con usted'
      : 'What may be going on for you';

    // Build the new section. We give it a slightly different visual treatment
    // (warm sand background with a navy left border) so it reads as a
    // companion piece to the green staff-reality block — same shape, but
    // clearly aimed at the leader, not the staff member.
    const newSection = document.createElement('div');
    newSection.className = 'r-section';
    newSection.setAttribute('data-org-injected', 'manager-reflection');
    newSection.innerHTML = `
      <div class="r-label">${escapeHtml(sectionLabel)}</div>
      <div class="manager-reflection" style="
        background: #FBF6E8;
        border-left: 3px solid #1B2A4A;
        border-radius: 0 10px 10px 0;
        padding: 16px 20px;
        font-size: 14px;
        line-height: 1.75;
        font-weight: 400;
        color: #2C2B27;
        font-style: italic;
      ">${escapeHtml(reflection)}</div>
    `;

    // The new divider that sits between this section and the next
    const newDivider = document.createElement('div');
    newDivider.className = 'r-divider';

    // Place the new section right after the divider that follows staff reality
    if (dividerAfterStaff && dividerAfterStaff.classList.contains('r-divider')) {
      // Insert: [staff section] [existing divider] [NEW section] [NEW divider] [next section]
      dividerAfterStaff.insertAdjacentElement('afterend', newSection);
      newSection.insertAdjacentElement('afterend', newDivider);
    } else {
      // Fallback: just append after the staff section with our own divider
      staffSection.insertAdjacentElement('afterend', newDivider);
      newDivider.insertAdjacentElement('afterend', newSection);
    }

    fullAnalysis.setAttribute('data-reflection-injected', '1');
  }

  // -----------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttr(str) { return escapeHtml(str); }

  // ===== Language toggle handler =====
  // When the user toggles language AFTER login, we need to re-render the org's
  // value chips and re-update localStorage so the rest of the app sees them
  // in the new language.
  function onLanguageChange() {
    if (!currentOrg || !Array.isArray(currentOrg.values)) return;
    // Re-derive the value names in the new language
    const newValueNames = currentOrg.values.map(function (v) {
      return valueName(v);
    });
    try { localStorage.setItem(LS_VALUES, JSON.stringify(newValueNames)); } catch(e) {}
    // Push into in-memory state of the existing app
    if (typeof window !== 'undefined') {
      window.orgValues = newValueNames;
    }
    // Re-render the chips visible in the Fast Mode values bar
    const chips = document.getElementById('fast-values-chips');
    if (chips) {
      chips.innerHTML = newValueNames.map(function (n) {
        return '<span class="fast-value-chip">' + escapeHtml(n) + '</span>';
      }).join('');
    }
    // Re-translate the "View definitions" buttons
    const link = document.getElementById('org-defs-link-top');
    if (link) link.textContent = getCurrentLang() === 'es' ? 'Ver definiciones' : 'View definitions';
    const btnSpan = document.querySelector('#btn-view-defs-results span');
    if (btnSpan) btnSpan.textContent = getCurrentLang() === 'es' ? 'Ver definiciones' : 'View definitions';
  }

  // Watch for language changes by polling vl_lang in storage and currentLang on window.
  // We poll because index.html's toggleLanguage doesn't fire a custom event we can listen to.
  let _lastSeenLang = getCurrentLang();
  setInterval(function () {
    const now = getCurrentLang();
    if (now !== _lastSeenLang) {
      _lastSeenLang = now;
      onLanguageChange();
    }
  }, 250);

  // Naive color darken: drops each RGB channel by ~12 to make a hover state.
  function darken(hex) {
    if (!hex || hex[0] !== '#' || hex.length !== 7) return hex;
    const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - 18);
    const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - 18);
    const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - 18);
    return '#' + [r, g, b].map(function (n) {
      const s = n.toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }

})();
