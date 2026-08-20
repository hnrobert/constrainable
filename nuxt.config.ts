// Nuxt 4 + Bun configuration for Constrainable Ingest
// SSR single-process app; API lives in server/, Vue UI in app/.
import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-30',
  devtools: { enabled: true },
  ssr: true,

  // Tailwind v4 (CSS-first) via the Vite plugin — NOT @nuxtjs/tailwindcss.
  vite: {
    plugins: [tailwindcss()],
    // email-poster/vue ships .vue source; esbuild can't pre-bundle .vue, so
    // exclude the package from dep optimization and let Vite compile it instead.
    //
    // PRE-DECLARE every runtime dep instead of letting Vite discover them lazily:
    // a mid-session discovery (e.g. first visit to the streams page importing
    // mpegts.js/socket.io-client) triggers re-optimization + a full reload, and
    // Safari serves the reload with a MIX of old/new module instances — two
    // runtime-core copies, each with its own currentRenderingInstance — which
    // crashes hydration with "null is not an object (evaluating
    // 'currentRenderingInstance.ce')". Optimizing everything up front removes
    // the second optimization wave entirely.
    optimizeDeps: {
      exclude: ['email-poster'],
      include: [
        'reka-ui',
        'class-variance-authority',
        'clsx',
        'tailwind-merge',
        'lucide-vue-next',
        '@lucide/vue',
        '@vueuse/core',
        'vue-sonner',
        'socket.io-client',
        'jose',
        'picomatch',
      ],
    },
    server: {
      // Vite's Host check 403s any caller that isn't localhost/127.0.0.1.
      // Allow `host.docker.internal` so a Dockerized SRS's on_publish hook can
      // call back into the dev app during OBS ingest testing. To actually
      // receive that call the dev server must also bind off-loopback — run
      // `HOST=0.0.0.0 bun run dev`. Production (the `app` container) is
      // unaffected (SRS reaches it on the compose bridge as `app:31954`).
      allowedHosts: ['host.docker.internal'],
    },
  },

  // shadcn-vue ui/ components resolve UNPREFIXED (<Button>, <Card>, …);
  // everything else keeps the documented dir-prefixed names
  // (<StreamsPlayer>, <RecordingsPlayer>, <StreamsActiveTable>) — there are two
  // Player.vue files, so a global pathPrefix:false would collide on them.
  components: [
    { path: '~/components/ui', pathPrefix: false, extensions: ['.vue'] },
    { path: '~/components', pathPrefix: true, extensions: ['.vue'] },
  ],

  // vue-sonner toast host: auto-registers the client-only <Toaster> component
  // (mounted once in app.vue) and injects vue-sonner/style.css. Pages fire
  // toasts via useToast() instead of a per-page element.
  modules: ['vue-sonner/nuxt', '@vueuse/nuxt'],

  // node-server preset. Socket.IO attaches to the same HTTP server via a
  // first-request lazy attach (server/middleware/00-socket.ts) — the Nitro
  // `listen` hook is NOT emitted by this preset, so we can't attach at startup.
  nitro: {
    preset: 'node-server',
    experimental: { tasks: false },
    // `bun:sqlite` is a Bun-only built-in (not an npm pkg, not a node: builtin),
    // so Rollup can't resolve it statically and warns "could not be resolved –
    // treating it as an external dependency". That's correct: it's resolved at
    // runtime by `bun`. Silence just that warning; keep Nitro's default filter
    // (CIRCULAR_DEPENDENCY / EVAL / unsupported sourcemap comments).
    rollupConfig: {
      onwarn(warning, warn) {
        const code = warning.code || ''
        const msg = warning.message || ''
        // `bun:sqlite` is a Bun-only built-in (not an npm pkg, not a node:
        // builtin), so Rollup can't resolve it statically and warns "could not
        // be resolved – treating it as an external dependency". Correct: it's
        // resolved at runtime by `bun`. Silence just that warning.
        if (code === 'UNRESOLVED_IMPORT' && msg.includes('bun:sqlite')) return
        // reka-ui ships JSDoc comment annotations (e.g. injectLocal) that
        // Rollup flags as INVALID_ANNOTATION and strips — harmless but noisy.
        if (
          code === 'INVALID_ANNOTATION' ||
          msg.includes('annotation that Rollup cannot interpret')
        ) {
          return
        }
        // Keep Nitro's default suppressions otherwise.
        if (
          !['CIRCULAR_DEPENDENCY', 'EVAL'].includes(code) &&
          !msg.includes('Unsupported source map comment')
        ) {
          warn(warning)
        }
      },
    },
  },

  // Static split deployments (API_ORIGIN set): data pages must NOT hydrate
  // from build-time payloads — those were prerendered against the throwaway
  // generate-time DB and would show stale/empty data forever. Disabling
  // payload extraction makes useFetch re-run on the client against the live
  // API origin.
  ...(process.env.API_ORIGIN ? { experimental: { payloadExtraction: false } } : {}),

  runtimeConfig: {
    // server-only (overridable via NUXT_* env at runtime)
    sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
    verifierSecret: process.env.AUTHMOD_VERIFIER_SECRET || 'dev-insecure-secret-change-me',
    rtmpAuthToken: process.env.RTMP_AUTH_TOKEN || 'dev-insecure-rtmp-token',
    dbPath: process.env.DB_PATH || './data/app.db',
    recordDir: process.env.RECORD_DIR || './records',
    srsApiBase: process.env.SRS_API_BASE || 'http://127.0.0.1:1985/api/v1',
    srsRtmpHost: process.env.SRS_RTMP_HOST || '127.0.0.1',
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    public: {
      // OPTIONAL ingest-host override (NAT / unusual setups). Default: derived
      // at runtime from API_ORIGIN or the origin the user browses from — see
      // app/composables/useObsConfig.ts.
      srsPublicHost: process.env.PUBLIC_HOST || '',
      srsApiPort: process.env.SRS_API_PORT || '1985',
      srsRtmpPort: process.env.SRS_RTMP_PORT || '1935',
      // Absolute API origin for split deployments (static frontend on a CDN,
      // API elsewhere). Empty = same-origin. Baked at `bun run generate` time.
      apiOrigin: process.env.API_ORIGIN || '',
    },
  },

  css: ['~/assets/css/main.css'],

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'Constrainable Ingest',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
      // Apply the persisted theme BEFORE paint to avoid a flash of the wrong
      // theme. useColorMode (storageKey 'ci.theme') mirrors this client-side;
      // stored value is 'auto' | 'light' | 'dark'.
      script: [
        {
          innerHTML:
            "(function(){try{var s=localStorage.getItem('ci.theme');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var d=s==='dark'||((s==='auto'||!s)&&m);document.documentElement.classList.toggle('dark',d);}catch(e){}})();",
          tagPosition: 'head',
        },
      ],
    },
  },
})
