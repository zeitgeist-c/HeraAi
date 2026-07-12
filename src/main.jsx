import { createRoot } from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import { lazy, Suspense } from 'react'
import './index.css'
import './i18n'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { Loader2 } from 'lucide-react'

const App = lazy(() => import('./App.jsx'))

export function LoadingFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <>
    <Toaster position="bottom-right" />
    <ErrorBoundary>
      <Suspense fallback={<LoadingFallback />}>
        <App />
      </Suspense>
    </ErrorBoundary>
  </>
)
