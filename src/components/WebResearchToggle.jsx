import { Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'

function WebResearchToggle({ enabled, onToggle, disabled }) {
  const { t } = useTranslation()

  return (
    <button
      title={enabled ? t('chat.tooltips.disable_research') : t('chat.tooltips.enable_research')}
      onClick={onToggle}
      disabled={disabled}
      className={`flex items-center justify-center p-2 backdrop-blur-sm rounded-xl transition-all border shadow-sm ${
        enabled
          ? 'bg-primary/20 border-primary text-primary shadow-primary/20'
          : 'bg-secondary/80 hover:bg-primary/20 hover:text-primary border-border/50'
      } disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      <Globe className="w-4 h-4" />
    </button>
  )
}

export default WebResearchToggle
