import { defineConfig, type InlineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

function disableServiceWorkerCodeSplitting(options: InlineConfig): void {
  const output = options.build?.rollupOptions?.output
  if (!output) {
    return
  }

  const outputs = Array.isArray(output) ? output : [output]
  for (const swOutput of outputs) {
    if (!swOutput || typeof swOutput !== 'object') {
      continue
    }

    const mutableOutput = swOutput as Record<string, unknown>
    delete mutableOutput.inlineDynamicImports
    mutableOutput.codeSplitting = false
  }
}

export default defineConfig({
  server: {
    proxy: {
      '/uploads': 'http://localhost:3001',
    },
  },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: {
        name: 'Pika.bg - Белот Онлайн',
        short_name: 'Пика',
        description: 'Играй белот онлайн с приятели',
        start_url: '/',
        display: 'standalone',
        background_color: '#0a0a0a',
        theme_color: '#d4a520',
        lang: 'bg',
        icons: [
          {
            src: '/icons/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icons/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icons/pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,svg,png,webp,mp3,woff2}'],
        injectionPoint: 'self.__WB_MANIFEST',
      },
      integration: {
        configureCustomSWViteBuild: disableServiceWorkerCodeSplitting,
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
})
