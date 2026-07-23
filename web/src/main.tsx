import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './design/base.css'
import { applyTokens, DEFAULT_TOKENS } from './design/tokens'

// Write the token custom properties to :root before first paint so base.css
// resolves against them. The DS token editor (a later phase) swaps the argument.
applyTokens(DEFAULT_TOKENS)

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root element')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
