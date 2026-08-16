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
  // Пре-съществуващ gap (тази fixture не беше обновена след "Fix private
  // room notification preferences" commit-а, който добави тези 3 опции) —
  // не е свързано с team/slot rewrite-а; поправено тук само за да не
  // гърми целият Playwright процес на notification сценария и да могат
  // останалите viewport-и/сценарии да се верифицират.
  isInActiveGame: () => false,
  areInGameNotificationsEnabled: () => true,
  onDisableInGameNotifications: () => {},
  onEnterPrivateRooms: () => {
    enterCount++
  },
})

;(window as any).__notifHarness = {
  controller,
  handleIncoming: (notice: unknown) => controller.handleIncoming(notice as any),
  getEnterCount: () => enterCount,
}
