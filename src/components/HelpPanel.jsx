import React from "react"
import "../memact-ui.css"
import "../faq-chevron.css"
import { Chevron } from "./Chevron.jsx"

const BASIC_FAQS = [
  {
    question: "What is Memact?",
    answer: "Memact is a playground where apps personalize based on what users choose to share."
  },
  {
    question: "Why would an app use Memact?",
    answer: "An app can send useful signals to Memact and use features that help it personalize better, with your permission."
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
    question: "What is Memact Wiki?",
    answer: "It is the private user wiki created from apps, Memact, and user edits. Apps can use it only inside what you allow."
  },
  {
    question: "Can I share my Wiki?",
    answer: "Not by default. Your Wiki should stay private unless you create a username-based share link yourself."
  },
  {
    question: "What is Playground?",
    answer: "Playground is where Memact features live. Apps can use a feature with an API key, and you can disconnect it later."
  },
  {
    question: "How does Adaptive Article Overview work?",
    answer: "An article app can send allowed reading activity. Memact turns that into reading memory, then the feature chooses an overview style the user is more likely to read."
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
    answer: "Features are tools built inside Memact, like a memory wiki, research map, or cognitive load estimate."
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
        <p className="muted">Clear answers about apps, consent, Wiki, Playground, and developer setup.</p>
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
