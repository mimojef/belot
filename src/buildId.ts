declare const __PWA_BUILD_ID__: string | undefined

export const CURRENT_BUILD_ID: string = typeof __PWA_BUILD_ID__ === 'string' ? __PWA_BUILD_ID__ : 'dev'
