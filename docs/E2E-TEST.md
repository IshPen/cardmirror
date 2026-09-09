# CardBridge — end-to-end test checklist

A concrete run to validate the whole chain live, once, before relying on it.
You need: the deployed dashboard (Pages), a Supabase + relay set up, and **two
CardMirror desktop machines** (or two profiles) — call them **A** and **B** —
plus the dashboard open in a browser.

Tick each box. Note the browser/OS you test in — repeat the crypto-dependent
rows (marked 🔐) in **Safari and Firefox**, not just Chrome, since WebCrypto
X25519 support varies.

## 0. Browser capability
- [ ] Open the dashboard. If a red **"Limited browser support"** banner appears,
      this browser can't do the crypto features — that's expected on unsupported
      browsers; switch to Chrome/Edge for the crypto rows.

## 1. Relay + monitoring (no keys needed)
- [ ] Overview shows **Relay live** (green) and a latency in the sidebar.
- [ ] Start a session on machine A → it appears in **Sessions** within ~60s
      (Refresh if needed), with participants/size/last-activity.
- [ ] Storage + Online + presence update as A/B join.

## 2. Member invite → Open  🔐
- [ ] Dashboard → **Member** → copy the `cmk1.…` code.
- [ ] On machine A, invite that code into A's session (normal CardMirror invite).
- [ ] Dashboard → **Poll for invites** (or wait) → the room now shows its **name**
      and an **Open** button.
- [ ] Click **Open** → the document renders with native styling + outline.
- [ ] **Go live** → edits made on A appear in the viewer within ~1–2s.
- [ ] Export **.docx** downloads and opens; version-history scrubber works.

## 3. Cross-device sync (the vault)  🔐
- [ ] In **Tokens → Sign in** (or the wizard's step 4) with your coach account →
      header chip turns green **Synced**.
- [ ] Open the dashboard in a **second browser/profile** → run the wizard →
      **Sign in** with the same coach account.
- [ ] Confirm the second browser now shows the **same tokens, doc names**, and
      the room from step 2 has an **Open** button (keys restored via the vault).
- [ ] Edit tokens on one browser → within ~15s they appear on the other.

## 4. One shared member code  🔐
- [ ] Browser 1 → **Member → "Use one code across my devices"** → note the new
      `cmk1.…` code; the badge shows **on**.
- [ ] Browser 2 → sign in → **Member** shows the **same** code (adopted from vault).
- [ ] On machine B, invite that shared code into a *new* session → it's received
      (poll) and **Open** works — on both browsers after a sync.

## 5. Race / robustness
- [ ] With browser 1 idle + signed in, enable the shared code on browser 2, then
      go back to browser 1 and Refresh → the shared code is **still intact** (not
      wiped) — validates the push-time identity guard.
- [ ] Reload a signed-in browser → you get the **"Sign in to sync"** chip/banner
      (password isn't stored); sign in → everything restores.

## 6. Telemetry (optional)
- [ ] After loading the deployed dashboard, the telemetry project's
      `usage_events` gains `app_open` / `heartbeat` rows with a `coach` hash.
- [ ] The analytics dashboard (after the read policy) shows your coach + docs.

## If something fails
- **Open never appears:** browser has no key (per-browser) — re-invite, or sign
  in so the vault restores keys.
- **Sync errors:** check the *Sync across devices* status line; a decrypt error
  means a changed Supabase password (re-initialise from the working browser).
- **Nothing crypto works + red banner:** unsupported browser — use Chrome/Edge.
