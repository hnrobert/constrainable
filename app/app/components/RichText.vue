<script setup lang="ts">
/**
 * Admin-authored rich text (organizer notes, registration notice, …):
 * Markdown via markdown-it, LaTeX formulas via KaTeX ($x^2$ inline, $$…$$
 * display — both render server-side too), and ```mermaid fenced diagrams
 * (client-side only: mermaid needs a browser, so until it swaps the SVG in the
 * raw diagram source stays visible as a code block — also the fallback when a
 * diagram fails to parse). Raw HTML is NOT interpreted (markdown-it
 * html:false) and mermaid runs at securityLevel 'strict' — admins get
 * Markdown, not script injection. Links open in a new tab; diagrams re-render
 * when the app theme toggles (mermaid bakes its colors at render time).
 */
import MarkdownIt from 'markdown-it'
import * as markdownItKatex from '@vscode/markdown-it-katex'
import 'katex/dist/katex.min.css'

const props = defineProps<{
  source: string
}>()

/**
 * The katex plugin ships TS-compiled CJS (`exports.default = fn` + __esModule),
 * so the resolved shape depends on WHO loads it: bundlers unwrap to the
 * function and so does bun's native interop, but Node's native import yields
 * `{ default: fn }` — and markdown-it's use() calls `plugin.apply(...)`, which
 * crashes SSR with "e.apply is not a function" the moment any rich text
 * renders. Unwrap nested `.default`s until we hold the callable, so every
 * load path (vite bundle / bun / node) works.
 */
function resolveKatexPlugin(ns: unknown): (md: InstanceType<typeof MarkdownIt>) => void {
  let p: unknown = ns
  for (let i = 0; typeof p !== 'function' && p && i < 3; i++) {
    p = (p as { default?: unknown }).default
  }
  if (typeof p !== 'function') throw new Error('@vscode/markdown-it-katex failed to resolve')
  return p as (md: InstanceType<typeof MarkdownIt>) => void
}

const md = new MarkdownIt({ html: false, breaks: true, linkify: true }).use(
  resolveKatexPlugin(markdownItKatex),
)

// Markdown links open in a new tab (guide links shouldn't navigate the app away).
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (token) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener')
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}

// Deterministic on server and client → v-html hydrates cleanly.
const html = computed(() => md.render(props.source ?? ''))

/* --------------------------- mermaid (client) ---------------------------- */
const root = ref<HTMLElement | null>(null)
// Diagram ids = vue instance uid + pass + index, so concurrent passes (source
// change racing a theme toggle) never reuse a mermaid render id, and a
// superseded pass stops instead of overwriting a newer one.
const uid = getCurrentInstance()?.uid ?? 0
let pass = 0
let observer: MutationObserver | null = null

async function renderDiagrams(): Promise<void> {
  if (!root.value || !import.meta.client) return
  const blocks = Array.from(root.value.querySelectorAll<HTMLElement>('pre > code.language-mermaid'))
  if (blocks.length === 0) return
  const mine = ++pass
  const mermaid = (await import('mermaid')).default
  if (mine !== pass) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
  })
  for (const [i, block] of blocks.entries()) {
    if (mine !== pass) return
    try {
      const { svg } = await mermaid.render(`rt-${uid}-${mine}-${i}`, block.textContent ?? '')
      // Keep the <code> (hidden) so later passes can re-render with a new theme.
      block.style.display = 'none'
      let holder = block.parentElement!.querySelector<HTMLElement>(':scope > .rt-mermaid')
      if (!holder) {
        holder = document.createElement('div')
        holder.className = 'rt-mermaid'
        block.parentElement!.appendChild(holder)
      }
      holder.innerHTML = svg
    } catch {
      /* parse error → leave the source visible as a code block */
    }
  }
}

onMounted(() => {
  void renderDiagrams()
  observer = new MutationObserver(() => void renderDiagrams())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
})
onBeforeUnmount(() => observer?.disconnect())
watch(
  () => props.source,
  () => nextTick(() => void renderDiagrams()),
)
</script>

<template>
  <!-- v-html is safe here: markdown-it runs with html:false (raw HTML escaped),
       KaTeX emits styled spans only, mermaid runs at securityLevel 'strict'. -->
  <div ref="root" class="prose prose-sm dark:prose-invert max-w-none" v-html="html" />
</template>

<style scoped>
.rt-mermaid {
  display: flex;
  justify-content: center;
  overflow-x: auto;
}
.rt-mermaid :deep(svg) {
  max-width: 100%;
  height: auto;
}
</style>
