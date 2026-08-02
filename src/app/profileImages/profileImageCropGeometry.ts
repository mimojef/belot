export type CropPoint = {
  x: number
  y: number
}

export type CropImageRect = {
  left: number
  top: number
  width: number
  height: number
}

export type DisplayCropSelection = {
  left: number
  top: number
  size: number
}

export type NaturalCropSelection = {
  x: number
  y: number
  size: number
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function calculateContainedImageRect(input: {
  containerWidth: number
  containerHeight: number
  naturalWidth: number
  naturalHeight: number
}): CropImageRect | null {
  const { containerWidth, containerHeight, naturalWidth, naturalHeight } = input
  if (containerWidth <= 0 || containerHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return null
  }

  const scale = Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight)
  const width = naturalWidth * scale
  const height = naturalHeight * scale
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  }
}

export function pointInImageRect(point: CropPoint, imageRect: CropImageRect): boolean {
  return point.x >= imageRect.left &&
    point.x <= imageRect.left + imageRect.width &&
    point.y >= imageRect.top &&
    point.y <= imageRect.top + imageRect.height
}

export function toImageLocalPoint(point: CropPoint, imageRect: CropImageRect): CropPoint | null {
  if (!pointInImageRect(point, imageRect)) return null
  return {
    x: clampNumber(point.x - imageRect.left, 0, imageRect.width),
    y: clampNumber(point.y - imageRect.top, 0, imageRect.height),
  }
}

export function createSquareCropFromDrag(input: {
  start: CropPoint
  current: CropPoint
  imageRect: Pick<CropImageRect, 'width' | 'height'>
  minSize?: number
}): DisplayCropSelection | null {
  const start = {
    x: clampNumber(input.start.x, 0, input.imageRect.width),
    y: clampNumber(input.start.y, 0, input.imageRect.height),
  }
  const current = {
    x: clampNumber(input.current.x, 0, input.imageRect.width),
    y: clampNumber(input.current.y, 0, input.imageRect.height),
  }
  const deltaX = current.x - start.x
  const deltaY = current.y - start.y
  const dirX = deltaX >= 0 ? 1 : -1
  const dirY = deltaY >= 0 ? 1 : -1
  const maxSizeX = dirX > 0 ? input.imageRect.width - start.x : start.x
  const maxSizeY = dirY > 0 ? input.imageRect.height - start.y : start.y
  const size = Math.min(Math.abs(deltaX), Math.abs(deltaY), maxSizeX, maxSizeY)
  if (size < (input.minSize ?? 4)) return null

  return {
    left: dirX > 0 ? start.x : start.x - size,
    top: dirY > 0 ? start.y : start.y - size,
    size,
  }
}

export function moveSquareCrop(input: {
  crop: DisplayCropSelection
  pointer: CropPoint
  offset: CropPoint
  imageRect: Pick<CropImageRect, 'width' | 'height'>
}): DisplayCropSelection {
  const size = Math.min(input.crop.size, input.imageRect.width, input.imageRect.height)
  return {
    left: clampNumber(input.pointer.x - input.offset.x, 0, input.imageRect.width - size),
    top: clampNumber(input.pointer.y - input.offset.y, 0, input.imageRect.height - size),
    size,
  }
}

export function isPointInsideCrop(point: CropPoint, crop: DisplayCropSelection): boolean {
  return point.x >= crop.left &&
    point.x <= crop.left + crop.size &&
    point.y >= crop.top &&
    point.y <= crop.top + crop.size
}

export function displayCropToNaturalCrop(input: {
  crop: DisplayCropSelection
  imageRect: Pick<CropImageRect, 'width' | 'height'>
  naturalWidth: number
  naturalHeight: number
}): NaturalCropSelection | null {
  if (
    input.crop.size <= 0 ||
    input.imageRect.width <= 0 ||
    input.imageRect.height <= 0 ||
    input.naturalWidth <= 0 ||
    input.naturalHeight <= 0
  ) {
    return null
  }

  const scaleX = input.naturalWidth / input.imageRect.width
  const scaleY = input.naturalHeight / input.imageRect.height
  const maxNaturalSize = Math.min(input.naturalWidth, input.naturalHeight)
  const size = clampNumber(Math.floor(input.crop.size * Math.min(scaleX, scaleY)), 1, maxNaturalSize)
  const x = clampNumber(Math.floor(input.crop.left * scaleX), 0, input.naturalWidth - size)
  const y = clampNumber(Math.floor(input.crop.top * scaleY), 0, input.naturalHeight - size)

  return { x, y, size }
}
