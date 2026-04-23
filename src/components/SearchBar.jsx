import { useEffect, useMemo, useRef, useState } from 'react'
import enterIcon from '../../assets/enter_icon.svg'
import micIcon from '../../assets/mic_icon.svg'

function isPrintableKey(event) {
  return (
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  )
}

function normalizeSpeechText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

export default function SearchBar({
  value,
  onChange,
  onSubmit,
  onSuggestionClick,
  placeholder = 'Search',
  loading = false,
  suggestions = [],
  timeFilters = [],
  activeTimeFilter = null,
  onTimeFilter,
  onFocusChange,
  onDockVisibilityChange,
  onVoiceStateChange,
  emptySuggestionMessage = '',
}) {
  const [focused, setFocused] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [typedBeforeSelection, setTypedBeforeSelection] = useState('')
  const [voiceState, setVoiceState] = useState('idle')
  const blurTimerRef = useRef(null)
  const dockPointerDownRef = useRef(false)
  const inputRef = useRef(null)
  const recognitionRef = useRef(null)
  const voiceSubmitTimerRef = useRef(null)
  const voiceStatusTimerRef = useRef(null)
  const finalVoiceTextRef = useRef('')
  const latestVoiceTextRef = useRef('')

  const visibleSuggestions = useMemo(() => suggestions.slice(0, 12), [suggestions])
  const chipsVisible = focused && !value.trim() && timeFilters.length > 0
  const emptySuggestionsVisible = focused && Boolean(emptySuggestionMessage) && visibleSuggestions.length === 0
  const dockVisible = focused && (chipsVisible || visibleSuggestions.length > 0 || emptySuggestionsVisible)
  const selectedSuggestion =
    selectedIndex >= 0 && selectedIndex < visibleSuggestions.length
      ? visibleSuggestions[selectedIndex]
      : null
  const previewActive = Boolean(selectedSuggestion)
  const inputValue = previewActive ? selectedSuggestion.completion : value
  const hasActiveSearchText = focused && Boolean(inputValue.trim())
  const voiceActive = voiceState === 'listening' || voiceState === 'processing'

  useEffect(() => {
    onFocusChange?.(focused)
  }, [focused, onFocusChange])

  useEffect(() => {
    onDockVisibilityChange?.(dockVisible)
  }, [dockVisible, onDockVisibilityChange])

  useEffect(() => {
    onVoiceStateChange?.(voiceState)
  }, [onVoiceStateChange, voiceState])

  useEffect(() => {
    if (!focused) {
      setSelectedIndex(-1)
    }
  }, [focused])

  useEffect(() => {
    if (!previewActive) {
      return
    }

    if (
      selectedIndex >= visibleSuggestions.length ||
      visibleSuggestions[selectedIndex]?.completion !== selectedSuggestion?.completion
    ) {
      setSelectedIndex(-1)
    }
  }, [previewActive, selectedIndex, selectedSuggestion?.completion, visibleSuggestions])

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) {
        window.clearTimeout(blurTimerRef.current)
      }
      if (voiceSubmitTimerRef.current) {
        window.clearTimeout(voiceSubmitTimerRef.current)
      }
      if (voiceStatusTimerRef.current) {
        window.clearTimeout(voiceStatusTimerRef.current)
      }
      recognitionRef.current?.abort?.()
    }
  }, [])

  const clearPreview = () => {
    setSelectedIndex(-1)
  }

  const maintainInputFocus = () => {
    if (blurTimerRef.current) {
      window.clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
    setFocused(true)
    window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
    })
  }

  const makeSearchPassive = () => {
    if (blurTimerRef.current) {
      window.clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
    dockPointerDownRef.current = false
    clearPreview()
    setFocused(false)
    window.requestAnimationFrame(() => {
      inputRef.current?.blur()
    })
  }

  const selectSuggestion = (index) => {
    if (!visibleSuggestions.length) {
      return
    }

    if (selectedIndex === -1) {
      setTypedBeforeSelection(value)
    }

    const bounded = Math.max(0, Math.min(index, visibleSuggestions.length - 1))
    setSelectedIndex(bounded)
  }

  const commitSuggestion = (suggestion, { keepFocused = true } = {}) => {
    if (!suggestion) {
      return
    }
    clearPreview()
    setTypedBeforeSelection(suggestion.completion)
    onChange?.(suggestion.completion)
    if (keepFocused) {
      maintainInputFocus()
    }
  }

  const submitSuggestion = (suggestion, { passiveAfterSubmit = false } = {}) => {
    if (!suggestion) {
      return
    }
    commitSuggestion(suggestion, { keepFocused: !passiveAfterSubmit })
    if (passiveAfterSubmit) {
      makeSearchPassive()
    }
    onSuggestionClick?.(suggestion.completion)
  }

  const handleBlur = () => {
    blurTimerRef.current = window.setTimeout(() => {
      if (dockPointerDownRef.current) {
        dockPointerDownRef.current = false
        inputRef.current?.focus()
        return
      }
      setFocused(false)
      clearPreview()
    }, 140)
  }

  const handleFocus = () => {
    if (blurTimerRef.current) {
      window.clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
    setFocused(true)
    if (selectedIndex === -1) {
      setTypedBeforeSelection(value)
    }
  }

  const startVoiceInput = () => {
    if (loading || typeof window === 'undefined') {
      return
    }

    if (voiceState === 'listening') {
      recognitionRef.current?.stop?.()
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      setVoiceState('unsupported')
      window.setTimeout(() => {
        setVoiceState('idle')
      }, 3200)
      return
    }

    if (voiceSubmitTimerRef.current) {
      window.clearTimeout(voiceSubmitTimerRef.current)
      voiceSubmitTimerRef.current = null
    }
    if (voiceStatusTimerRef.current) {
      window.clearTimeout(voiceStatusTimerRef.current)
      voiceStatusTimerRef.current = null
    }

    const recognition = new SpeechRecognition()
    recognitionRef.current = recognition
    finalVoiceTextRef.current = ''
    latestVoiceTextRef.current = ''
    recognition.lang = 'en-US'
    recognition.continuous = false
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      clearPreview()
      setFocused(true)
      setVoiceState('listening')
      window.requestAnimationFrame(() => {
        inputRef.current?.focus({ preventScroll: true })
      })
    }

    recognition.onresult = (event) => {
      let interim = ''
      let finalText = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index]?.[0]?.transcript || ''
        if (event.results[index]?.isFinal) {
          finalText += transcript
        } else {
          interim += transcript
        }
      }

      const spokenText = normalizeSpeechText(finalText || interim)
      if (!spokenText) {
        return
      }

      onChange?.(spokenText)
      latestVoiceTextRef.current = spokenText
      if (finalText) {
        finalVoiceTextRef.current = spokenText
        setVoiceState('processing')
      }
    }

    recognition.onerror = () => {
      setVoiceState('unsupported')
      window.setTimeout(() => {
        setVoiceState('idle')
      }, 2800)
    }

    recognition.onend = () => {
      const finalText = normalizeSpeechText(finalVoiceTextRef.current || latestVoiceTextRef.current)
      recognitionRef.current = null
      if (!finalText) {
        setVoiceState('idle')
        return
      }

      setVoiceState('processing')
      voiceSubmitTimerRef.current = window.setTimeout(() => {
        setVoiceState('done')
        makeSearchPassive()
        onSubmit?.(finalText)
        voiceStatusTimerRef.current = window.setTimeout(() => {
          setVoiceState('idle')
        }, 2200)
      }, 420)
    }

    try {
      recognition.start()
    } catch {
      setVoiceState('unsupported')
      window.setTimeout(() => {
        setVoiceState('idle')
      }, 2200)
    }
  }

  return (
    <section className={`search-cluster ${dockVisible ? 'is-attached' : ''}`}>
      <form
        className={`search-shell ${focused || value.trim() ? 'is-active' : ''} ${dockVisible ? 'is-attached' : ''}`}
        onSubmit={(event) => {
          event.preventDefault()
          if (selectedSuggestion) {
            submitSuggestion(selectedSuggestion, { passiveAfterSubmit: true })
            return
          }
          onSubmit?.(value)
          makeSearchPassive()
        }}
      >
        <input
          ref={inputRef}
          className={`search-input ${!value ? 'is-empty' : ''} ${previewActive ? 'is-preview' : ''}`}
          value={inputValue}
          onChange={(event) => {
            clearPreview()
            onChange?.(event.target.value)
          }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={(event) => {
            if (previewActive && isPrintableKey(event)) {
              event.preventDefault()
              clearPreview()
              onChange?.(`${typedBeforeSelection}${event.key}`)
              return
            }

            if (previewActive && event.key === 'Backspace') {
              event.preventDefault()
              clearPreview()
              onChange?.(typedBeforeSelection.slice(0, -1))
              return
            }

            if (previewActive && event.key === 'Delete') {
              event.preventDefault()
              clearPreview()
              onChange?.(typedBeforeSelection)
              return
            }

            if (event.key === 'ArrowDown') {
              event.preventDefault()
              if (selectedIndex === -1) {
                setTypedBeforeSelection(value)
                selectSuggestion(0)
                return
              }
              selectSuggestion((selectedIndex + 1) % visibleSuggestions.length)
              return
            }

            if (event.key === 'ArrowUp') {
              event.preventDefault()
              if (selectedIndex === -1) {
                setTypedBeforeSelection(value)
                selectSuggestion(visibleSuggestions.length - 1)
                return
              }
              selectSuggestion((selectedIndex - 1 + visibleSuggestions.length) % visibleSuggestions.length)
              return
            }

            if (event.key === 'Escape') {
              clearPreview()
              setFocused(false)
              event.currentTarget.blur()
              return
            }

            if (event.key === 'Tab' && selectedSuggestion) {
              event.preventDefault()
              commitSuggestion(selectedSuggestion)
              return
            }

            if (event.key === 'Enter' && selectedSuggestion) {
              event.preventDefault()
              submitSuggestion(selectedSuggestion, { passiveAfterSubmit: true })
            }
          }}
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="search"
          enterKeyHint="search"
          aria-label="Input"
        />

        <button
          className={`search-button ${hasActiveSearchText ? 'is-enter' : 'is-mic'} ${voiceActive ? 'is-listening' : ''}`}
          type={hasActiveSearchText ? 'submit' : 'button'}
          aria-label={hasActiveSearchText ? 'Submit' : 'Speak'}
          data-tooltip={hasActiveSearchText ? 'Enter' : 'Speak'}
          disabled={loading}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!hasActiveSearchText) {
              startVoiceInput()
            }
          }}
        >
          <img src={hasActiveSearchText ? enterIcon : micIcon} alt="" aria-hidden="true" />
        </button>
      </form>

      {dockVisible ? (
        <div
          className={`suggestion-dock ${dockVisible ? 'is-attached' : ''}`}
          onPointerDownCapture={() => {
            dockPointerDownRef.current = true
          }}
          onPointerUpCapture={() => {
            window.setTimeout(() => {
              dockPointerDownRef.current = false
            }, 0)
          }}
        >
          {chipsVisible ? (
            <div className="time-chip-row" role="group" aria-label="Time filters">
              {timeFilters.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={`time-filter-chip ${activeTimeFilter === filter.value ? 'is-active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onTimeFilter?.(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          ) : null}

          {visibleSuggestions.length ? (
            <>
              {!chipsVisible ? <div className="suggestion-heading">SUGGESTIONS</div> : null}

              <div
                className="suggestion-list"
                onWheel={(event) => {
                  event.stopPropagation()
                }}
              >
                {visibleSuggestions.map((suggestion, index) => (
                <button
                    key={suggestion.id}
                    type="button"
                    className={`suggestion-card ${selectedIndex === index ? 'is-active' : ''}`}
                    onPointerDown={(event) => event.preventDefault()}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => selectSuggestion(index)}
                    onMouseLeave={clearPreview}
                    onClick={() => submitSuggestion(suggestion, { passiveAfterSubmit: true })}
                  >
                    <span className="suggestion-meta">{suggestion.category}</span>
                    <span className="suggestion-title">{suggestion.title}</span>
                    <span className="suggestion-subtitle">{suggestion.subtitle}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {emptySuggestionsVisible ? (
            <div className="suggestion-empty">
              {emptySuggestionMessage}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
