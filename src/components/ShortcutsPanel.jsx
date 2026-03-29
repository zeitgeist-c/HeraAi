import { useState } from 'react'
import { Keyboard, X, ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const DEFAULT_SHORTCUTS = [
  { id: 'new_chat', keys: ['Ctrl', 'N'], description: 'Start new chat' },
  { id: 'send_message', keys: ['Enter'], description: 'Send message' },
  { id: 'send_multiline', keys: ['Shift', 'Enter'], description: 'New line in message' },
  { id: 'voice_input', keys: ['Click', 'Mic'], description: 'Toggle voice input' },
  { id: 'web_search', keys: ['Click', 'Globe'], description: 'Toggle web search' },
]

function ShortcutsPanel({ onClose }) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col h-full bg-background text-foreground p-6 pt-12">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Keyboard className="w-6 h-6 text-primary" />
          <h2 className="text-xl font-bold">Keyboard Shortcuts</h2>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-secondary rounded-full">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3">
        {DEFAULT_SHORTCUTS.map((shortcut) => (
          <div key={shortcut.id} className="flex items-center justify-between p-3 bg-card border rounded-lg">
            <span className="text-sm">{shortcut.description}</span>
            <div className="flex items-center gap-1">
              {shortcut.keys.map((key, idx) => (
                <span key={idx} className="flex items-center">
                  <kbd className="px-2 py-1 bg-secondary text-xs rounded border">{key}</kbd>
                  {idx < shortcut.keys.length - 1 && <ArrowRight className="w-3 h-3 mx-1 text-muted-foreground" />}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 p-3 bg-muted/50 rounded-lg text-xs text-muted-foreground">
        More shortcuts coming soon! You can customize keyboard shortcuts in future updates.
      </div>
    </div>
  )
}

export default ShortcutsPanel
