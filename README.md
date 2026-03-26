**Memact**

**Version** `v8.0`

Query the Past.
It quietly records what you do on your computer and lets you find it later.
Instead of searching the internet again, you can query your own past.

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
- What was that article about async Python I read last week?
- Find that thing about JWT authentication
- What did I read about transformer models?
- What did I do yesterday evening?
- What did I watch today?
- When did I last use Chrome?
- Did I look at the grocery order?
- What led me to start working on this?
- What was I doing before I opened that repo?
- Show me everything connected to that research session
- Show me my learning journey on machine learning
- What's the difference between what I read about Vue vs React?
- What led me to start working on authentication?
- Is there a connection between that async Python thing and the database optimization I read about?

---

**What Memact Records**

Memact records changes in your attention — what you were focused
on and what you actually read.

For browser activity, Memact extracts the full text of articles,
documentation, and pages you read, then distils them into key
concepts. This means you can find something by describing what it
was about, not just where you saw it.

For all apps, Memact records:

- switching between apps
- opening a new page or document
- moving from one task to another

It does not record keystrokes, passwords, or screenshots.

---

**How It Works**

`capture activity -> understand connections -> build episodic graph -> search it later`

No folders.
No tagging.
No manual organization.

---

**Episodic Graph**

As Memact records your activity, it quietly builds
a map of how things connect.

It groups related moments into sessions. A session
might be an hour of research on a topic, a coding
session, or a reading block. Each session is linked
to the sessions that came before and after it,
based on what you were doing and why.

This means Memact understands more than just what
you did. It understands the shape of your work.
How one thing led to another. What was foundational
and what built on top of it.

When you search, Memact uses this map to find not
just the moment you are looking for, but the context
around it. The session it belonged to. What triggered
it. What followed from it.

The episodic graph runs entirely on your device.
Nothing is sent anywhere.

---

**Principles**

- everything stays on your device
- no cloud services
- no external APIs
- no remote AI calls
- append-only memory
- your data is exportable and portable
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

- Button opacity communicates hierarchy: stronger buttons are primary, softer buttons are secondary, and faint buttons are disabled.
- Primary actions use the accent blue tint: background `rgba(40, 74, 128, 0.14)` with hover `rgba(40, 74, 128, 0.20)` and border `rgba(88, 126, 188, 0.26)`.
- Secondary/supporting actions use the neutral white tint: background `rgba(255, 255, 255, 0.05)` with hover `rgba(255, 255, 255, 0.10)` and border `rgba(255, 255, 255, 0.12)`.
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

Install:

> ⚠️ **First install takes 10–20 minutes.**
> `sentence-transformers` downloads PyTorch (~1.5GB). This happens
> once. After that, Memact runs fully offline.
> To skip the download: remove `sentence-transformers` from
> `requirements.txt` before installing. Memact will use its
> built-in hash embedding — search still works, just less precise.

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
