---
name: content_query
triggers:
  - "where did i see"
  - "where did i read about"
  - "where did i see that"
  - "did i look at"
  - "did i read"
  - "what was that page about"
  - "what was that message about"
  - "i remember something about"
  - "i saw something about"
  - "that article"
  - "that message"
  - "that thread"
  - "that note"
  - "that docs page"
  - "that video"
  - "that post"
  - "that thing"
  - "remember"
filters:
  - content_match
priority: relevance
---
When this skill activates, the query likely describes something the user read or encountered - a concept, topic, note, message, thread, or piece of information. Match against extracted keyphrases and full captured page text in the vector index, including articles, docs, threads, chats, and other information-heavy pages. Prioritize semantic similarity over recency. Return the top 3 events with source title, keyphrases, and timestamp as a single sentence followed by supporting evidence.
