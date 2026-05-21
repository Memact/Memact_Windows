import React from "react"
import "../memact-ui.css"
import "../faq-chevron.css"
import { Chevron } from "./Chevron.jsx"

const BASIC_FAQS = [
  {
    question: "What is Memact?",
    answer: "Memact helps apps personalize better using what users choose to share."
  },
  {
    question: "Why would an app use Memact?",
    answer: "An app can send useful signals to Memact and get better personalization back later, with your permission."
  },
  {
    question: "Does an app get all my data?",
    answer: "No. An app only gets what you allow. You can review access and disconnect it."
  },
  {
    question: "What does Memact store?",
    answer: "Memact stores useful memory created from app signals, user choices, and optional capture sources."
  },
  {
    question: "Is the browser extension required?",
    answer: "No. Apps that use Memact can work without it. The extension is optional for extra capture where you choose to use it."
  }
]

const CONTROL_FAQS = [
  {
    question: "What can I control?",
    answer: "Which apps are connected, what they can use, and whether they keep access."
  },
  {
    question: "What is Data Transparency?",
    answer: "It shows what an app can use, what Memact creates from it, and what the app may receive."
  }
]

const DEVELOPER_FAQS = [
  {
    question: "How does an app connect to Memact?",
    answer: "Register an app, use the SDK/API, send capture events, and request features only after access is approved."
  },
  {
    question: "Where does the API key live?",
    answer: "On the server. Never in browser code, public repos, logs, or user-facing settings."
  },
  {
    question: "What are features?",
    answer: "Features are tools built on Memact memory, like a user memory wiki, research map, or cognitive load estimate."
  }
]

const LEGAL_FAQS = [
  {
    question: "Who runs Memact?",
    answer: (
      <>
        Memact is a project by{" "}
        <a className="inline-help-link" href="https://github.com/keepsloading" target="_blank" rel="noreferrer">Keeps Loading</a>.
        Core repos are source-available under their repository licenses.
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
        {" "}Do not send secrets, private exports, or API keys by email.
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

export function HelpPanel() {
  return (
    <section className="panel help-panel">
      <div>
        <p className="eyebrow">Help</p>
        <h2>Frequently asked questions</h2>
        <p className="muted">Clear answers about apps, consent, data transparency, and developer setup.</p>
      </div>

      <div className="faq-section">
        <p className="faq-section-title">Basics</p>
        {BASIC_FAQS.map((faq, index) => (
          <FaqItem faq={faq} key={faq.question} open={index === 0} />
        ))}
      </div>

      <div className="faq-section faq-section-advanced">
        <p className="faq-section-title">Controls</p>
        {CONTROL_FAQS.map((faq) => (
          <FaqItem faq={faq} key={faq.question} />
        ))}
      </div>

      <div className="faq-section faq-section-advanced">
        <p className="faq-section-title">Developers</p>
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
