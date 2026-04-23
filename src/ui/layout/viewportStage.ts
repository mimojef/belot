export type ViewportStageMetricsConfig = {
  baseWidth: number
  baseHeight: number
  minScale: number
  maxScale: number
  viewportHorizontalPadding: number
  viewportVerticalPadding: number
  reservedTopSpace?: number
}

export type ViewportStageMetrics = {
  stageScale: number
  scaledStageWidth: number
  scaledStageHeight: number
  viewportWidth: number
  viewportHeight: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getViewportSize(config: ViewportStageMetricsConfig): {
  width: number
  height: number
} {
  if (typeof window === 'undefined') {
    return {
      width: config.baseWidth + config.viewportHorizontalPadding * 2,
      height:
        config.baseHeight +
        config.viewportVerticalPadding * 2 +
        (config.reservedTopSpace ?? 0),
    }
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  }
}

export function getViewportStageMetrics(
  config: ViewportStageMetricsConfig,
): ViewportStageMetrics {
  const viewport = getViewportSize(config)
  const availableWidth = Math.max(
    320,
    viewport.width - config.viewportHorizontalPadding * 2,
  )
  const availableHeight = Math.max(
    320,
    viewport.height -
      config.viewportVerticalPadding * 2 -
      (config.reservedTopSpace ?? 0),
  )
  const widthScale = availableWidth / config.baseWidth
  const heightScale = availableHeight / config.baseHeight
  const stageScale = clamp(
    Math.min(widthScale, heightScale, config.maxScale),
    config.minScale,
    config.maxScale,
  )

  return {
    stageScale,
    scaledStageWidth: Math.round(config.baseWidth * stageScale),
    scaledStageHeight: Math.round(config.baseHeight * stageScale),
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  }
}

export function createViewportResizeHandler(onResize: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }

  let animationFrameId: number | null = null

  const scheduleResize = (): void => {
    if (animationFrameId !== null) {
      return
    }

    animationFrameId = window.requestAnimationFrame(() => {
      animationFrameId = null
      onResize()
    })
  }

  window.addEventListener('resize', scheduleResize)
  window.addEventListener('orientationchange', scheduleResize)

  return () => {
    if (animationFrameId !== null) {
      window.cancelAnimationFrame(animationFrameId)
    }

    window.removeEventListener('resize', scheduleResize)
    window.removeEventListener('orientationchange', scheduleResize)
  }
}
