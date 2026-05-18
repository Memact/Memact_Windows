import React from "react"
import "../memact-ui.css"
import "../faq-chevron.css"
import { Chevron } from "./Chevron.jsx"

const BASIC_FAQS = [
  {
    question: "What is Memact?",
    answer: "Memact is permissioned intent infrastructure for apps. It helps apps understand what users are trying to do from approved digital activity."
  },
  {
    question: "Where does Memact run?",
    answer: "Apps use a small Memact client SDK. Evidence can come from approved browser activity and, if enabled, a local helper. Apps receive scoped intent and context, not raw private data."
  },
  {
    question: "Does an app get my private data?",
    answer: "No. Apps only get the scoped context or intent signals allowed by the permissions and categories you approve."
  },
  {
    question: "How does consent work?",
    answer: "You see what an app wants to use before anything is connected. Approval is optional. Data Transparency lets you review details first."
  },
  {
    question: "What are activity categories?",
    answer: "They limit which approved activity an app can use, like research pages, news, AI conversations, developer activity, or media."
  }
]

const INTENT_FAQS = [
  {
    question: "What activity can be used?",
    answer: "Only approved activity can be used. That can include page titles, URLs, selected text, captions, transcripts, timestamps, or other disclosed evidence fields."
  },
  {
    question: "What does Memact produce?",
    answer: "Memact turns approved activity into intent hypotheses, context signals, evidence cards, and scoped summaries. Intent predictions are hypotheses, not facts."
  },
  {
    question: "What does an app receive?",
    answer: "Only scoped intent or context allowed by the app key, your consent, selected scopes, and activity categories."
  },
  {
    question: "Can I change what an app uses?",
    answer: "Yes. You can narrow scopes and categories before approving. Where available, you can revoke access later so future use stops."
  }
]

const DEVELOPER_FAQS = [
  {
    question: "How does a developer use the Memact API?",
    answer: (
      <>
        <p>Use Memact as permissioned intent infrastructure for your app.</p>
        <ol>
          <li>Register your app in Memact and choose the scopes and categories your feature needs.</li>
          <li>Add a <strong>Connect Memact</strong> button. Send users to the consent page.</li>
          <li>Link a Data Transparency page beside consent to explain approved activity, intended context, retention, and revocation.</li>
          <li>After approval, store the returned connection id for the user.</li>
          <li>Keep the API key in server environment config, not in client code.</li>
          <li>Verify before requesting intent or context.</li>
          <li>For intent predictions, call the backend intent endpoint with the connection id, required scopes, approved categories, and approved activity.</li>
          <li>Use only the evidence-backed hypotheses Memact returns.</li>
        </ol>
      </>
    )
  },
  {
    question: "Where should the API key be stored?",
    answer: (
      <>
        Treat the API key like a server-side secret. It starts with <code>mka_</code>. Keep it in server environment config or a secret manager. Never put it in browser code, public repos, or user-facing settings.
      </>
    )
  },
  {
    question: "Is a Data Transparency page required?",
    answer: "Yes. Any app using Memact consent must link a Data Transparency page. It explains what approved activity may be used, what intent or context the app wants, retention, and revocation."
  }
]

const LEGAL_FAQS = [
  {
    question: "Who runs Memact?",
    answer: (
      <>
        Memact is a project by{" "}
        <a className="inline-help-link" href="https://github.com/keepsloading" target="_blank" rel="noreferrer">Keeps Loading</a>.
        Core repos are source-available under their repository licenses, and contributions are accepted under the CLA.
        Memact branding assets are not licensed with the code.
      </>
    )
  },
  {
    question: "How can I contact Memact?",
    answer: (
      <>
        For access, security, or project questions, contact{" "}
        <a className="inline-help-link" href="mailto:keepsloading@gmail.com">keepsloading@gmail.com.</a>
        {" "}Do not send secrets or API keys by email.
      </>
    )
  }
]

function FaqItem({ faq, open = false }) {
  return (
    <details className="faq-item" open={open}>
      <summary className="faq-trigger">
        <span className="faq-question">{faq.question}</span>
        <Chevron />
      </summary>
      <div className="faq-answer">
        {typeof faq.answer === "string" ? <p>{faq.answer}</p> : <div className="faq-answer-content">{faq.answer}</div>}
      </div>
    </details>
  )
}

export function LearnPanel() {
  return (
    <section className="panel help-panel">
      <div>
        <p className="eyebrow">Learn More</p>
        <h2>Frequently asked questions</h2>
        <p className="muted">Answers about how Memact works, what apps can see, and how consent is controlled.</p>
      </div>

      <div className="faq-section">
        <p className="faq-section-title">Basics</p>
        {BASIC_FAQS.map((faq, index) => (
          <FaqItem faq={faq} key={faq.question} open={index === 0} />
        ))}
      </div>

      <div className="faq-section faq-section-advanced">
        <p className="faq-section-title">Intent and controls</p>
        {INTENT_FAQS.map((faq) => (
          <FaqItem faq={faq} key={faq.question} />
        ))}
      </div>

      <div className="faq-section faq-section-advanced">
        <p className="faq-section-title">For developers</p>
        {DEVELOPER_FAQS.map((faq) => (
          <FaqItem faq={faq} key={faq.question} />
        ))}
      </div>

      <div className="faq-section faq-section-advanced">
        <p className="faq-section-title">Legal and contact</p>
        {LEGAL_FAQS.map((faq) => (
          <FaqItem faq={faq} key={faq.question} />
        ))}
      </div>
    </section>
  )
}
