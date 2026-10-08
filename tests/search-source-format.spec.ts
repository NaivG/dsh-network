/**
 * Pins the two-line hit format the search card relies on.
 *
 * `makeSearchProvider` (dsh/index.js) renders every hit as
 * `N. [title](url)` + GFM hard break + an indented snippet/date line. dsh's
 * markdown renderer maps the hard break (two trailing spaces) to `<br>`,
 * while a bare `\n` inside a paragraph is a soft break that collapses to a
 * space — so this exact whitespace is what makes the card show a blue link
 * with its description on a second line.
 *
 * The host module has host-side imports (persist/serverClient), so the
 * function is extracted from the source the same way
 * presentationmeta.spec.ts extracts compactPresentation.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const hostSource = readFileSync(
  fileURLToPath(new URL('../dsh/index.js', import.meta.url)),
  'utf8',
)
const match = hostSource.match(/function renderSearchSourceItem\(source\)\s*\{[\s\S]*?\n\}/)
if (!match) {
  throw new Error('Could not locate renderSearchSourceItem in dsh/index.js')
}
// The function reads two module-level whitespace constants — extract their
// real declarations too, so the test exercises the actual source text (a
// stray edit of `'  '` or `'    '` must fail here, not silently pass).
const hardBreakDecl = hostSource.match(/^const GFM_HARD_BREAK = .*$/m)
const descIndentDecl = hostSource.match(/^const SEARCH_DESC_INDENT = .*$/m)
if (!hardBreakDecl || !descIndentDecl) {
  throw new Error('Could not locate GFM_HARD_BREAK / SEARCH_DESC_INDENT in dsh/index.js')
}
type RenderSearchSourceItem = (
  source: { url: string; title?: string; snippet?: string; publishedAt?: string },
) => string
// eslint-disable-next-line no-new-func
const renderSearchSourceItem = new Function(
  `${hardBreakDecl[0]}\n${descIndentDecl[0]}\n${match[0]}; return renderSearchSourceItem;`,
)() as RenderSearchSourceItem

describe('renderSearchSourceItem — two-line card format', () => {
  it('puts the link on line 1 and the snippet/date on an indented line 2', () => {
    const out = renderSearchSourceItem({
      url: 'https://example.com/a',
      title: 'Example Page',
      snippet: 'Some description.',
      publishedAt: '2026-02-01',
    })
    const lines = out.split('\n')
    expect(lines).toHaveLength(2)
    // Line 1 must end in EXACTLY two spaces — the GFM hard break.
    expect(lines[0]).toBe('[Example Page](https://example.com/a)  ')
    // Line 2 indents four spaces: the content column of a two-digit marker,
    // so the line stays inside the list item for `1. ` and `10. ` alike.
    expect(lines[1]).toBe('    Some description. (2026-02-01)')
  })

  it('keeps a bare link (no trailing spaces) when there is no snippet or date', () => {
    const out = renderSearchSourceItem({ url: 'https://example.com/b', title: 'B' })
    expect(out).toBe('[B](https://example.com/b)')
  })

  it('falls back to the hostname when the engine gave no title', () => {
    const out = renderSearchSourceItem({ url: 'https://example.net/x', snippet: 's' })
    expect(out).toBe('[example.net](https://example.net/x)  \n    s')
  })

  it('never lets a title break out of the link', () => {
    const out = renderSearchSourceItem({
      url: 'https://example.com/c',
      title: 'bad ] title [ with\nnewlines',
      snippet: 's',
    })
    expect(out).toBe('[bad  title  with newlines](https://example.com/c)  \n    s')
  })

  it('collapses snippet whitespace to one line', () => {
    const out = renderSearchSourceItem({
      url: 'https://example.com/d',
      title: 'D',
      snippet: 'a\n  b\tc',
    })
    expect(out).toBe('[D](https://example.com/d)  \n    a b c')
  })
})
