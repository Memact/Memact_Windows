**Memact**

**Version** `v0.4`

Memact is a searchable memory of your activity.
It quietly records what you do on your computer and lets you find it later.
Instead of searching the internet again, you can search your own past actions.

---

**How To Think About It**

You do not remember files or tabs.
You remember moments.

Like:

- that docs page explaining a thing
- that message you saw in chat
- that video you watched
- that thing you saw in a thread or forum

Memact helps you find those moments again.

---

**What You Can Ask**

Memact is built around one simple interaction:

Ask Memact...

You can ask things like:

- Where did I see that?
- Where did I read about delivery fees?
- What was that message about resetting my password?
- What did I do yesterday evening?
- What did I watch today?
- When did I last use Chrome?
- Did I look at the grocery order?

---

**What Memact Records**

Memact does not track everything.

It records changes in attention. In simple terms, what you were focused on.

For example:

- switching between apps
- opening a new page
- moving from one task to another

It does not record keystrokes or anything invasive.

---

**How It Works**

`capture activity -> store it locally -> search it later`

No folders.
No tagging.
No manual organization.

---

**Principles**

- everything stays on your device
- no cloud services
- no external APIs
- no remote AI calls
- append-only memory
- search, not dashboards

---

**Interface**

The app is minimal by design:

- one search box
- suggestions from recent activity
- one clear answer
- optional details if you want more

---

**Button & Color Principles**

- Primary actions use the accent blue tint: background `rgba(40, 74, 128, 0.08)` with hover `rgba(40, 74, 128, 0.16)` and border `rgba(40, 74, 128, 0.16)`.
- Secondary/supporting actions use the neutral white tint: background `rgba(255, 255, 255, 0.08)` with hover `rgba(255, 255, 255, 0.16)` and border `rgba(255, 255, 255, 0.16)`.
- Ghost/icon buttons are transparent at rest and pick up a subtle hover tint.
- Destructive actions may use a red accent on hover to signal caution.

---

**Browser Support**

Memact includes a local extension for Chromium-based browsers.

It captures:

- current tab
- page titles
- URLs

All data stays on your device and is sent only to:

[http://127.0.0.1:38453](http://127.0.0.1:38453)

---

**Storage**

Data is stored locally at:

`%USERPROFILE%\AppData\Local\memact\memact.db`

---

**Running Memact**

Requirements:

- Python 3.11+
- PyQt6
- pywinauto
- sentence-transformers
`sentence-transformers` pulls in PyTorch (large download). If you want a lighter setup, remove it from `requirements.txt` and Memact will fall back to its local deterministic embedding path.

Install:

```powershell
pip install -r requirements.txt
```

Run:

```powershell
python main.py
```

---

**Notes**

- Windows-first prototype
- fully local system
- focused on remembering and finding your activity
- not a workflow automation tool
- if the compiled Go engine is not built or running, Memact automatically falls back to the pure-Python path

---

**Go Engine (Optional)**

Requirements:

- Go 1.22+

Build:

```powershell
scripts\build_engine.ps1
```

Run:

```powershell
scripts\run_engine.ps1
```

---

**License**

Memact is proprietary and confidential. See LICENSE.
