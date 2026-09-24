/**
 * Beste alanındaki tekerlek olayının hangi kaydırıcıya gideceğine karar verir.
 *
 * Neden ayrı modül: `defaultPrevented` ile doğrulanamıyor — React tekerlek
 * dinleyicisini pasif bağladığı için `preventDefault()` gözlemlenebilir bir iz
 * bırakmaz. Karar saf bir fonksiyona çıkarılınca hem üretim yolu hem testler
 * aynı mantığı kullanır.
 *
 * Kural: iç kaydırıcı (yazı alanı) kendi içinde kayabiliyorsa tekerleği o
 * tüketir; başına veya sonuna geldiğinde devamı sohbete geçer (zincirleme).
 */

export const WHEEL_TARGET_CHAT = 'chat'
export const WHEEL_TARGET_INNER = 'inner'

export function resolveWheelTarget(deltaY, innerScroller) {
  if (!innerScroller || !deltaY) return WHEEL_TARGET_CHAT

  const scrollHeight = Number(innerScroller.scrollHeight) || 0
  const clientHeight = Number(innerScroller.clientHeight) || 0
  const scrollTop = Number(innerScroller.scrollTop) || 0

  // İç kaydırıcı gerçekten kayabiliyor mu? Kayamıyorsa tekerlek sohbete gider.
  if (scrollHeight <= clientHeight + 1) return WHEEL_TARGET_CHAT

  const atTop = scrollTop <= 0
  const atBottom = scrollTop + clientHeight >= scrollHeight - 1

  if (deltaY < 0 && atTop) return WHEEL_TARGET_CHAT
  if (deltaY > 0 && atBottom) return WHEEL_TARGET_CHAT
  return WHEEL_TARGET_INNER
}
