export const QUICK_PROMPTS = [
  {
    id: 'summarize',
    labelKey: 'chat.quick_prompts.summarize_label',
    textTr: 'Aşağıdaki içeriği maddeler halinde özetle:\n\n',
    textEn: 'Summarize the content below as bullet points:\n\n',
  },
  {
    id: 'proofread',
    labelKey: 'chat.quick_prompts.proofread_label',
    textTr: 'Aşağıdaki metindeki yazım ve dilbilgisi hatalarını düzelt, anlamı değiştirme:\n\n',
    textEn: 'Fix spelling and grammar below without changing meaning:\n\n',
  },
  {
    id: 'tabulate',
    labelKey: 'chat.quick_prompts.tabulate_label',
    textTr: 'Aşağıdaki bilgileri tablo haline getir:\n\n',
    textEn: 'Turn the information below into a table:\n\n',
  },
  {
    id: 'translate_en',
    labelKey: 'chat.quick_prompts.translate_en_label',
    textTr: 'Aşağıdaki metni İngilizceye çevir:\n\n',
    textEn: 'Translate the text below into English:\n\n',
  },
]

export function resolveQuickPrompt(prompt, language) {
  return String(language || '').toLowerCase().startsWith('en') ? prompt.textEn : prompt.textTr
}
