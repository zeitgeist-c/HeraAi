export function buildResearchContext(results, question) {
  const formatted = results
    .map((r, i) => `[Kaynak ${i + 1}] Başlık: ${r.title}\nURL: ${r.url}\nİçerik: ${r.content}`)
    .join('\n\n---\n\n');

  return `Aşağıdaki web arama sonuçlarına dayanarak kullanıcının sorusunu cevapla.
Sadece verilen kaynakları kullan. Kaynaklarda bilgi yoksa bunu belirt, asla uydurma bilgi üretme.
Cevabın sonunda kullanılan kaynakları [N] formatında belirt.

Kullanıcı Sorusu: ${question}

Web Sonuçları:
${formatted}`;
}

export function buildSourcesList(results) {
  return results.map((r, i) => ({
    index: i + 1,
    title: r.title,
    url: r.url,
  }));
}
