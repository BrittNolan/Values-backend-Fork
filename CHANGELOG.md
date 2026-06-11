# Values Lab — Changelog & Developer Context

**App:** Values Lab  
**Owner:** Karabed Leadership Group (KLG)  
**Live URL:** https://values-backend.vercel.app  
**GitHub Repo:** https://github.com/karabedleadershipgroup/Values-backend  
**Deployed via:** Vercel (auto-deploys on GitHub push)

---

## App Overview

Values Lab is a trauma-informed leadership response tool for managers in social services nonprofits. The user enters their organization's values and describes a staff behavior, and the app generates structured coaching guidance grounded in those values.

---

## File Structure

```
/
├── index.html          # Full frontend + system prompt logic
├── vercel.json         # Vercel routing config
├── package.json        # Node dependencies
├── api/
│   ├── analyze.js      # Backend: calls Anthropic API with system prompt from frontend
│   ├── speak.js        # Backend: calls ElevenLabs API to generate audio (Rachel voice)
│   └── audio.js        # DEPRECATED — delete this file
└── CHANGELOG.md        # This file
```

---

## Environment Variables (set in Vercel dashboard)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Powers the AI analysis via Claude |
| `ELEVENLABS_API_KEY` | Powers the audio readback via ElevenLabs |

---

## How the App Works

1. User sees a **confidentiality gate** (beta testing terms) and must click "I Agree" to enter
2. **Step 1:** User enters organizational values (type or tap common values chips)
3. **Step 2:** User describes the staff behavior and selects first time or repeated
4. Frontend builds a **system prompt** and sends it to `/api/analyze`
5. `analyze.js` calls the Anthropic API and returns structured JSON
6. Results are displayed across several sections (see below)
7. User can click **Listen** to hear an ElevenLabs audio summary (Rachel voice)
8. User can click **PDF** to download a print-ready report

---

## Results Sections (in display order)

1. **Behavior Observed** — faithful restatement of what the user typed, no embellishment
2. **Staff's Possible Reality** — compassionate possibilities for what may be driving the behavior (trauma, burnout, mental health, family stress)
3. **Values Analysis** — each value marked Misaligned or Upheld with explanation
4. **Impact** — client, team, and organizational impact
5. **Values-Aligned Behavior** — what the behavior looks like when aligned (framed positively)
6. **Conversation Guide** — five-part script in this order:
   - Opening
   - Curiosity question
   - Observation + impact
   - Shared expectation
   - Alignment statement
7. **Recommended Next Step** — Coach, Document, or Escalate with reasoning

---

## System Prompt Design Principles

The system prompt lives inside the `generate()` function in `index.html`. Key rules baked into the prompt:

- **Trauma-informed language only** — no "I need you to", "you must", "you have to", "this is unacceptable"
- **Invitational and curious tone** — "I'm wondering...", "I'd like to explore...", "What I noticed was..."
- **Expectations framed as shared commitments** — "As a team, we're committed to..."
- **No shaming language** anywhere in the output
- **behaviorObserved must be faithful** to what the user typed — no added details or assumptions
- **staffReality** offers warm, human context for the leader to hold — not an excuse for behavior
- **First time vs. repeated** adjusts the tone: first time = curiosity and care; repeated = warm but clear, names the pattern without blame

---

## Change History

### Session: June 11, 2026

**Added super-admin onboarding console (`superadmin.html`):**
- New page for KLG-side administrators: sign in with email/password, see every onboarded organization, and onboard new ones through a 5-step wizard (organization → branding → values with optional Spanish → shared login → review)
- Wizard auto-generates a strong password and shows the credentials once, with copy buttons, after creation
- New API route `api/superadmin/orgs.js` (GET list / POST create). POST creates the `orgs` row, the shared auth user (`<username>+placeholder@valuesalign.app`), and the `org_members` link, rolling back on partial failure
- Access is gated server-side by `requireSuperAdmin` (new in `lib/auth.js`): the auth user must have `app_metadata.is_super_admin = true`, which only the service role can set — org accounts get a 403
- New `scripts/create-super-admin.js` — one-time script to create (or upgrade) a super-admin account: `node scripts/create-super-admin.js <email> [password]`
- `vercel.json` + `dev-server.js`: `/superadmin.html` excluded from the SPA rewrite so the page is served directly

**Added optional Handbook step to the onboarding wizard (now 6 steps):**
- New step between Values and Login: paste the company's condensed policy text (`=== POLICY NAME ===` sections), optional HR contact and version label — or skip entirely
- The screen includes the format rules and an example, plus a live character/section counter; review screen summarizes what will be saved and warns when no section headers are detected
- `api/superadmin/orgs.js` POST now inserts the `handbooks` row (`is_active: true`) when provided — `/api/analyze` picks it up automatically — and rolls it back with the rest on partial failure

**One-time set-password links for NEW onboardings (`setup-password.html`):**
- Creating an org now also produces a one-time link so the client chooses their own password — no secret ever travels by email. The success screen shows the link, and "Copy all details" produces an email-ready block (passwordless when the link exists)
- New client page `/setup-password.html`: verifies the token (`auth.verifyOtp` with `token_hash` — no Supabase redirect-allowlist needed, link lives on the app's own domain), shows a choose-your-password form personalized with the org name, then drops them into the app signed in. Used/expired links get a friendly single-use explanation
- New `lib/setup-link.js` (recovery-token link builder); `api/superadmin/orgs.js` returns `setup_link` on creation (fail-soft)
- Links are single-use and expire per the Supabase "Email OTP expiry" dashboard setting (raised to 24h)
- Scope note: links exist ONLY for new onboardings by design. A per-org "Password link" button for existing orgs was briefly added and then removed unshipped-to-clients — that capability is a separate paid feature to be built when the client requests it

**Single front door for admins (`org-loader.js`):**
- Super admins now sign in at the main app (`/`) like everyone else and are automatically redirected to `/superadmin.html` — both on fresh login and when returning with an existing session. Org logins are unaffected.

**Role Play handbook made per-organization (`api/roleplay.js`):**
- The coach prompt previously told the AI the LifeMoves handbook was available for EVERY org (hardcoded import from `lib/handbook.js`). It now checks the signed-in org's own `handbooks` row: orgs with one get a correctly-named reference, orgs without get no handbook block at all (lookup is fail-open)
- Compliance log now records the actual signed-in org name instead of always "LifeMoves"
- `lib/handbook.js` is no longer imported anywhere; kept as reference material for the LifeMoves handbook content

### Session: April 15, 2026

**Changes made to `index.html`:**
- Added ElevenLabs audio integration (replaced browser speech synthesis)
  - Listen button calls `/api/speak` which returns audio from ElevenLabs
  - Rachel voice, `eleven_multilingual_v2` model
  - Full audio player with play/pause, seek ±15s, progress bar
- Added confidentiality gate screen (beta testing terms, must agree before entering)
- Added common nonprofit values quick-select chips (28 values, tap to add/remove)
- Rewrote system prompt with full trauma-informed language rules
- Renamed "Correct behavior" → "Values-aligned behavior"
- Renamed "Conversation script" → "Conversation guide"
- Renamed "Expectation" → "Shared expectation"
- Renamed "Behavior + impact" → "Observation + impact"
- Renamed "Recommended action" → "Recommended next step"
- Added `staffReality` field — "Staff's possible reality" section
- Reordered conversation guide: Curiosity question now appears after Opening
- Added CRITICAL instruction: `behaviorObserved` must not add or invent details
- PDF updated to match all UI changes

**Added `api/speak.js`:**
- New backend route for ElevenLabs text-to-speech
- Uses Rachel voice ID: `21m00Tcm4TlvDq8ikWAM`
- Reads `ELEVENLABS_API_KEY` from Vercel environment variables
- Returns audio/mpeg stream

**`api/audio.js`:** Mark for deletion — superseded by `speak.js`

---

## Important Notes for Future Sessions

- Always pull `index.html` from GitHub at the start of a session before making changes
- The system prompt is inside `index.html` in the `generate()` function — there is no separate prompt file
- The JSON schema returned by the AI must include: `behaviorObserved`, `staffReality`, `valuesAnalysis`, `impact`, `valuesAlignedBehavior`, `conversationScript`, `recommendedAction`
- `conversationScript` keys: `opening`, `curiosityQuestion`, `behaviorImpact`, `expectation`, `alignmentStatement`
- After any change to `index.html`, commit to GitHub — Vercel redeploys automatically
- If Vercel is serving an old version, go to the Vercel dashboard and click Redeploy
