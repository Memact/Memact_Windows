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
    question: "How does it work?",
    answer: "Apps ask to connect, send useful signals after permission, and receive only the memory or feature output their access allows."
  },
  {
    question: "What can I review?",
    answer: "You can review what an app wants to use, what Memact may create from it, and what the app may receive back."
  },
  {
    question: "Can I disconnect an app?",
    answer: "Yes. Disconnecting an app stops future access for that app."
  }
]

const DEVELOPER_FAQS = [
  {
    question: "How does a developer start?",
    answer: "Register an app, keep the API key on the server, add a Connect Memact flow, then use the SDK/API to send capture events and run features after access is approved."
  },
  {
    question: "What does the SDK do?",
    answer: "The SDK helps apps send capture events, verify access, list available features, run a feature, and retrieve permitted schemas or memory summaries."
  },
  {
    question: "What are schema packets?",
    answer: "Schema packets are technical memory structures Memact features can use. They belong in developer docs and advanced surfaces, not basic user consent copy."
  }
]

const FEATURE_FAQS = [
  {
    question: "What are Memact features?",
    answer: "Features are tools built inside Memact, such as Memory Wiki, Cognitive Load, and Research Map."
  },
  {
    question: "Is the extension required?",
    answer: "No. Apps can send signals directly through Memact. The extension is optional for extra capture where the user chooses to enable it."
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
        <p>{faq.answer}</p>
      </div>
    </details>
  )
}

export function LearnPanel() {
  return (
    <section className="panel help-panel">
      <div>
        <p className="eyebrow">Learn More</p>
        <h2>Personalization made better with Memact</h2>
        <p className="muted">A playground where apps personalize based on what users choose to share.</p>
      </div>

      <div className="faq-section">
        <p className="faq-section-title">Basics</p>
        {BASIC_FAQS.map((faq, index) => (
          <FaqItem faq={faq} key={faq.question} open={index === 0} />
        ))}
      </div>

      <div className="faq-section faq-section-advanced">
        <p className="faq-section-title">Developers</p>
        {DEVELOPER_FAQS.map((faq) => (
          <FaqItem faq={faq} key={faq.question} />
        ))}
      </div>

      <div className="faq-section faq-section-advanced">
        <p className="faq-section-title">Features</p>
        {FEATURE_FAQS.map((faq) => (
          <FaqItem faq={faq} key={faq.question} />
        ))}
      </div>
    </section>
  )
}
