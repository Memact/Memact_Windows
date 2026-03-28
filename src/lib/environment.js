const MOBILE_UA_PATTERN =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Windows Phone/i

function safeMatchMedia(query) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(query).matches
}

function detectBrowserFamily(ua) {
  if (/Edg\/|EdgA\/|EdgiOS\//.test(ua)) return 'edge'
  if (/OPR\/|Opera/.test(ua)) return 'opera'
  if (/Vivaldi\//.test(ua)) return 'vivaldi'
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox'
  if (/Chrome\/|Chromium\/|CriOS\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'unknown'
}

function browserNameForFamily(family, braveDetected) {
  if (braveDetected) return 'Brave'
  switch (family) {
    case 'edge':
      return 'Microsoft Edge'
    case 'chrome':
      return 'Google Chrome'
    case 'opera':
      return 'Opera'
    case 'vivaldi':
      return 'Vivaldi'
    case 'firefox':
      return 'Mozilla Firefox'
    case 'safari':
      return 'Safari'
    default:
      return 'Browser'
  }
}

function extensionsUrlForFamily(family, braveDetected) {
  if (braveDetected) return 'brave://extensions/'
  switch (family) {
    case 'edge':
      return 'edge://extensions/'
    case 'chrome':
      return 'chrome://extensions/'
    case 'opera':
      return 'opera://extensions/'
    case 'vivaldi':
      return 'vivaldi://extensions/'
    default:
      return ''
  }
}

function helpUrlForFamily(family, braveDetected) {
  if (braveDetected) {
    return 'https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave'
  }

  switch (family) {
    case 'edge':
      return 'https://learn.microsoft.com/microsoft-edge/extensions-chromium/getting-started/extension-sideloading'
    case 'chrome':
      return 'https://support.google.com/chrome_webstore/answer/2664769'
    case 'opera':
      return 'https://help.opera.com/en/extensions/'
    case 'vivaldi':
      return 'https://help.vivaldi.com/desktop/appearance-customization/extensions/'
    case 'firefox':
      return 'https://support.mozilla.org/kb/find-and-install-add-ons-add-features-to-firefox'
    default:
      return ''
  }
}

export function detectClientEnvironment() {
  if (typeof navigator === 'undefined') {
    return {
      family: 'edge',
      name: 'Microsoft Edge',
      mobile: false,
      coarsePointer: false,
      compactViewport: false,
      isIOS: false,
      isAndroid: false,
      isBrave: false,
      extensionsUrl: 'edge://extensions/',
      helpUrl:
        'https://learn.microsoft.com/microsoft-edge/extensions-chromium/getting-started/extension-sideloading',
      extensionCapable: true,
      extensionRecommended: true,
      automaticCaptureSupported: true,
      setupSupported: true,
    }
  }

  const ua = navigator.userAgent || ''
  const coarsePointer = safeMatchMedia('(pointer: coarse)')
  const compactViewport = safeMatchMedia('(max-width: 820px)')
  const isIOS =
    /iPad|iPhone|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1)
  const isAndroid = /Android/i.test(ua)
  const mobile =
    MOBILE_UA_PATTERN.test(ua) ||
    isIOS ||
    isAndroid ||
    (coarsePointer && compactViewport)
  const family = detectBrowserFamily(ua)
  const isBrave = Boolean(navigator.brave)
  const effectiveFamily = isBrave ? 'brave' : family
  const extensionCapable = !mobile && ['edge', 'chrome', 'opera', 'vivaldi', 'brave'].includes(effectiveFamily)
  const extensionRecommended = !mobile && effectiveFamily === 'edge'
  const automaticCaptureSupported = extensionCapable

  return {
    family: effectiveFamily,
    name: browserNameForFamily(family, isBrave),
    mobile,
    coarsePointer,
    compactViewport,
    isIOS,
    isAndroid,
    isBrave,
    extensionsUrl: extensionsUrlForFamily(family, isBrave),
    helpUrl: helpUrlForFamily(family, isBrave),
    extensionCapable,
    extensionRecommended,
    automaticCaptureSupported,
    setupSupported: extensionCapable,
  }
}
