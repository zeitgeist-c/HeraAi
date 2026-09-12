import { FileUp, Globe2, Scissors, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

function WelcomeScreen({ onCrop, isCropActive = false, onResearch, onAttach }) {
  const { t } = useTranslation()
  const actions = [
    {
      id: 'research',
      icon: Globe2,
      title: t('chat.welcome_actions.research_title'),
      description: t('chat.welcome_actions.research_description'),
      action: onResearch,
    },
    {
      id: 'crop',
      icon: Scissors,
      title: isCropActive
        ? t('chat.welcome_actions.crop_cancel_title')
        : t('chat.welcome_actions.crop_title'),
      description: isCropActive
        ? t('chat.welcome_actions.crop_cancel_description')
        : t('chat.welcome_actions.crop_description'),
      action: onCrop,
      active: isCropActive,
    },
    {
      id: 'attach',
      icon: FileUp,
      title: t('chat.welcome_actions.attach_title'),
      description: t('chat.welcome_actions.attach_description'),
      action: onAttach,
    },
  ]

  return (
    <section className="hera-fade-in mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-4 py-10">
      <div className="mb-7">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-violet-500/10 text-primary ring-1 ring-primary/15">
          <Sparkles className="h-5 w-5" />
        </div>
        <h2 className="text-[23px] font-semibold leading-tight tracking-[-0.025em] text-foreground">
          {t('chat.welcome_title')}
        </h2>
        <p className="mt-2 max-w-md text-[13px] leading-relaxed text-muted-foreground">
          {t('chat.welcome_subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 min-[430px]:grid-cols-3">
        {actions.map(({ id, icon: Icon, title, description, action, active = false }) => (
          <button
            key={id}
            type="button"
            onClick={action}
            aria-pressed={id === 'crop' ? active : undefined}
            className={`group flex min-w-0 items-start gap-3 rounded-2xl border p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:bg-card hover:shadow-md active:translate-y-0 ${
              active ? 'border-primary/35 bg-primary/[0.08] ring-1 ring-primary/15' : 'border-border/80 bg-card/75'
            }`}
          >
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors group-hover:bg-primary/10 group-hover:text-primary ${
              active ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
            }`}>
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold text-foreground">{title}</span>
              <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">{description}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

export default WelcomeScreen
