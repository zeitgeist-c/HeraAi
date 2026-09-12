import { describe, expect, it } from 'vitest'

import {
  processAttachmentFile,
  resolveAttachmentType,
  validateAttachmentGroup,
} from './fileParsers.js'

function pngBytes(extra = []) {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra])
}

function pdfBytes(prefixLength = 0) {
  const content = new TextEncoder().encode('%PDF-1.7\n%%EOF')
  const bytes = new Uint8Array(prefixLength + content.length)
  bytes.set(content, prefixLength)
  return bytes
}

describe('attachment parsing', () => {
  it('infers an empty MIME type from a supported extension and extracts UTF-8 text', async () => {
    const result = await processAttachmentFile(new File(['Merhaba\r\nDünya'], 'notes.txt'))
    expect(result).toMatchObject({ mimeType: 'text/plain', kind: 'text', modelText: 'Merhaba\nDünya' })
  })

  it('sanitizes HTML while retaining structural text', async () => {
    const result = await processAttachmentFile(new File([
      '<script>alert(1)</script><h1>Başlık</h1><p>Metin</p><ul><li>Madde</li></ul>',
    ], 'page.html', { type: 'text/html' }))
    expect(result.modelText).toContain('# Başlık')
    expect(result.modelText).toContain('Metin')
    expect(result.modelText).toContain('- Madde')
    expect(result.modelText).not.toContain('alert')
  })

  it('accepts a valid image signature and rejects a spoofed one', async () => {
    await expect(processAttachmentFile(new File([pngBytes()], 'scan.png', { type: 'image/png' })))
      .resolves.toMatchObject({ kind: 'image', mimeType: 'image/png' })
    await expect(processAttachmentFile(new File(['not-png'], 'scan.png', { type: 'image/png' })))
      .rejects.toMatchObject({ code: 'attachment_type_mismatch' })
  })

  it('canonicalizes PDF MIME values and accepts a header within the first 1024 bytes', async () => {
    await expect(processAttachmentFile(new File([pdfBytes()], 'document.pdf', {
      type: 'application/x-pdf',
    }))).resolves.toMatchObject({ kind: 'pdf', mimeType: 'application/pdf' })

    await expect(processAttachmentFile(new File([pdfBytes(1023)], 'prefixed.pdf', {
      type: 'text/plain',
    }))).resolves.toMatchObject({ kind: 'pdf', mimeType: 'application/pdf' })
  })

  it('rejects a spoofed PDF and a header that starts beyond the compatibility window', async () => {
    await expect(processAttachmentFile(new File(['not-a-pdf'], 'spoofed.pdf', {
      type: 'application/pdf',
    }))).rejects.toMatchObject({ code: 'attachment_type_mismatch' })
    await expect(processAttachmentFile(new File([pdfBytes(1024)], 'late-header.pdf')))
      .rejects.toMatchObject({ code: 'attachment_type_mismatch' })
  })

  it('rejects legacy DOC and extension/MIME mismatches', () => {
    expect(() => resolveAttachmentType(new File(['x'], 'legacy.doc', { type: 'application/msword' })))
      .toThrow(expect.objectContaining({ code: 'attachment_unsupported' }))
    expect(() => resolveAttachmentType(new File(['x'], 'notes.txt', { type: 'application/pdf' })))
      .toThrow(expect.objectContaining({ code: 'attachment_type_mismatch' }))
  })

  it('rejects invalid JSON, corrupt DOCX and oversized groups', async () => {
    await expect(processAttachmentFile(new File(['{broken'], 'data.json', { type: 'application/json' })))
      .rejects.toMatchObject({ code: 'attachment_invalid' })
    await expect(processAttachmentFile(new File(['PK\u0003\u0004broken'], 'bad.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }))).rejects.toMatchObject({ code: 'attachment_invalid' })
    const files = Array.from({ length: 11 }, (_, index) => ({ name: `${index}.txt`, size: 1 }))
    expect(() => validateAttachmentGroup(files)).toThrow(expect.objectContaining({ code: 'attachment_count_exceeded' }))
  })

  it('extracts XLSX sheets as text with sheet names', async () => {
    const { default: XLSX } = await import('xlsx')
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['Ad', 'Yas'], ['Ali', 30]]),
      'Kisiler',
    )
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['Urun', 'Fiyat'], ['Elma', 10]]),
      'Stok',
    )
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
    const result = await processAttachmentFile(new File([buffer], 'veriler.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }))
    expect(result).toMatchObject({ mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'text' })
    expect(result.modelText).toContain('Kisiler')
    expect(result.modelText).toContain('Ali')
    expect(result.modelText).toContain('Stok')
    expect(result.modelText).toContain('Elma')
  })

  it('extracts legacy XLS workbooks as text', async () => {
    const { default: XLSX } = await import('xlsx')
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['Ad', 'Yas'], ['Ayse', 25]]),
      'Kisiler',
    )
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'biff8' })
    const result = await processAttachmentFile(new File([buffer], 'veriler.xls', {
      type: 'application/vnd.ms-excel',
    }))
    expect(result).toMatchObject({ mimeType: 'application/vnd.ms-excel', kind: 'text' })
    expect(result.modelText).toContain('Kisiler')
    expect(result.modelText).toContain('Ayse')
  })

  it('rejects spoofed spreadsheets and reports empty ones', async () => {
    await expect(processAttachmentFile(new File(['not-a-workbook'], 'sahte.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }))).rejects.toMatchObject({ code: 'attachment_type_mismatch' })

    const { default: XLSX } = await import('xlsx')
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), 'Bos')
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
    await expect(processAttachmentFile(new File([buffer], 'bos.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }))).rejects.toMatchObject({ code: 'attachment_empty' })
  })
})
