import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.jsx'

// Sentry — only initializes when VITE_SENTRY_DSN is set as an env var.
// Locally and during early development this stays a no-op (DSN absent).
// In Vercel, paste your project DSN under Settings → Environment Variables
// and Sentry starts capturing prod errors automatically.
const dsn = import.meta.env.VITE_SENTRY_DSN
if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: false, blockAllMedia: false }),
    ],
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    // Tag every event so we can tell prod from preview at a glance.
    initialScope: { tags: { app: 'hyundai-service-tracker' } },
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
