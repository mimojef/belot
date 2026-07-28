// Браузърна тестова "сглобка" за мобилна проверка на реалния
// "частна маса е създадена" popup (src/ui/notifications/privateRoomCreatedNotification.ts),
// засегнат от bb0b636 и все още активен в потока от ca321c7 (навигира към
// частните маси -> сега води до новата чакалня, вместо направо в списъка).
import { createPrivateRoomCreatedNotification } from '/src/ui/notifications/privateRoomCreatedNotification.ts'

const container = document.createElement('div')
document.body.appendChild(container)

let enterCount = 0

const controller = createPrivateRoomCreatedNotification({
  container,
  onEnterPrivateRooms: () => {
    enterCount++
  },
})

;(window as any).__notifHarness = {
  controller,
  handleIncoming: (notice: unknown) => controller.handleIncoming(notice as any),
  getEnterCount: () => enterCount,
}
