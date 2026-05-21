function enhanceEmbedCode() {
  document.querySelectorAll(".embed-code").forEach((details) => {
    if (details.dataset.memactTutorial === "ready") return
    const summary = details.querySelector("summary")
    const originalPre = details.querySelector("pre")
    const originalCode = originalPre?.querySelector("code")
    if (!summary || !originalPre || !originalCode) return

    const fullCode = originalCode.textContent || ""
    const steps = splitEmbedSteps(fullCode)

    details.dataset.memactTutorial = "ready"
    summary.textContent = ""
    summary.classList.add("embed-trigger")

    const title = document.createElement("span")
    title.className = "embed-title"
    title.textContent = "Connect tutorial"

    const subtitle = document.createElement("span")
    subtitle.className = "embed-subtitle"
    subtitle.textContent = "Numbered wiring guide with code inside each step."

    const chevron = document.createElement("span")
    chevron.className = "faq-chevron embed-chevron"
    chevron.setAttribute("aria-hidden", "true")
    chevron.innerHTML = '<svg class="chevron-icon" viewBox="0 0 24 24" focusable="false"><path d="M6.5 9.25L12 14.75L17.5 9.25"></path></svg>'

    summary.append(title, subtitle, chevron)

    const tutorial = document.createElement("div")
    tutorial.className = "embed-tutorial"

    const lead = document.createElement("p")
    lead.className = "embed-tutorial-lead"
    lead.textContent = "Follow the flow in order. Each step has the code it needs."
    tutorial.appendChild(lead)

    steps.forEach((step, index) => {
      const section = document.createElement("section")
      section.className = "embed-step"

      const heading = document.createElement("h3")
      heading.textContent = `${index + 1}. ${step.title}`
      section.appendChild(heading)

      const body = document.createElement("p")
      body.textContent = step.body
      section.appendChild(body)

      if (step.code.trim()) {
        const codeWrap = document.createElement("div")
        codeWrap.className = "embed-code-wrap"

        const copyButton = document.createElement("button")
        copyButton.type = "button"
        copyButton.className = "embed-copy-button"
        copyButton.textContent = "Copy"
        copyButton.setAttribute("aria-label", `Copy code for step ${index + 1}`)
        copyButton.addEventListener("click", () => copyCode(copyButton, step.code.trim()))

        const pre = document.createElement("pre")
        const code = document.createElement("code")
        code.textContent = step.code.trim()
        pre.appendChild(code)
        codeWrap.appendChild(copyButton)
        codeWrap.appendChild(pre)
        section.appendChild(codeWrap)
      }

      tutorial.appendChild(section)
    })

    originalPre.replaceWith(tutorial)
  })
}

function showSignOutOnlyOnAccount() {
  document.querySelectorAll(".dashboard-head").forEach((head) => {
    const label = head.querySelector(".eyebrow")?.textContent.trim().toLowerCase()
    const signOut = head.querySelector(".sign-out-button")
    if (!signOut || !label) return
    signOut.hidden = label !== "account"
  })
}

async function copyCode(button, text) {
  try {
    await navigator.clipboard.writeText(text)
    const previous = button.textContent
    button.textContent = "Copied"
    button.dataset.copied = "true"
    window.setTimeout(() => {
      button.textContent = previous || "Copy"
      delete button.dataset.copied
    }, 1400)
  } catch {
    button.textContent = "Copy failed"
    window.setTimeout(() => {
      button.textContent = "Copy"
    }, 1400)
  }
}

function splitEmbedSteps(code) {
  const markerPattern = /^\/\/\s*(\d+)\.\s*(.+)$/gm
  const matches = [...code.matchAll(markerPattern)]
  if (!matches.length) {
    return [{
      title: "Use the starter snippet",
      body: "Start with this code, then move each piece into the right place in your app.",
      code
    }]
  }

  return matches.map((match, index) => {
    const next = matches[index + 1]
    const start = match.index + match[0].length
    const end = next ? next.index : code.length
    const rawTitle = match[2].replace(/\.$/, "").trim()
    const rawCode = code.slice(start, end).trim()
    const body = describeStep(rawTitle, index)
    return {
      title: titleForStep(rawTitle, index),
      body,
      code: rawCode
    }
  }).filter((step) => step.title || step.code)
}

function titleForStep(title, index) {
  const titles = [
    "Add the Connect Memact button",
    "Add the Data Transparency link",
    "Read the connection id after approval",
    "Verify access before doing work",
    "Use only approved access"
  ]
  return titles[index] || title
}

function describeStep(title, index) {
  const descriptions = [
    "Put this URL behind your own Connect Memact button. It opens the approval screen for this app.",
    "Put this URL next to consent. It explains what the app can send, what Memact may create, summaries, retention, and revocation for this app.",
    "After the user approves, Memact redirects back to your app with a connection id.",
    "Keep the private mka_ Memact API key in server environment config. Your backend sends it to Memact before sending events or running features; do not put it in browser code.",
    "Use the verified scopes and categories as the boundary for what your app does next."
  ]
  return descriptions[index] || title
}

function enhanceMemactUi() {
  enhanceEmbedCode()
  showSignOutOnlyOnAccount()
}

enhanceMemactUi()
new MutationObserver(enhanceMemactUi).observe(document.documentElement, {
  childList: true,
  subtree: true
})
