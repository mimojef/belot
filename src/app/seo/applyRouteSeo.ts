const BASE_URL = 'https://www.pika.bg'

type RouteSeoConfig = {
  title: string
  description: string
  robots: string
}

const ROUTE_SEO: Record<string, RouteSeoConfig> = {
  '/': {
    title: 'Pika.bg – Белот онлайн с реални играчи',
    description:
      'Играй белот онлайн в Pika.bg. Избери маса, състезавай се с реални играчи и развивай своя профил, ранг и статистика.',
    robots: 'index, follow',
  },
  '/lobby': {
    title: 'Лоби за белот онлайн | Pika.bg',
    description:
      'Избери маса за белот онлайн, създай частна игра с приятели и следи активните играчи в лобито на Pika.bg.',
    robots: 'index, follow',
  },
  '/players': {
    title: 'Играчите в Pika.bg – профили и статистика',
    description:
      'Разгледай публичните профили на играчите в Pika.bg, тяхното ниво, ранг, изиграни игри и игрова статистика.',
    robots: 'index, follow',
  },
  '/ranking': {
    title: 'Класация по белот | Pika.bg',
    description:
      'Виж класацията на играчите в Pika.bg по баланс, ранг, победи и партньорска оценка.',
    robots: 'index, follow',
  },
  '/tournaments': {
    title: 'Турнири по белот | Pika.bg',
    description:
      'Разгледай активните турнири по белот в Pika.bg, създай собствен турнир и се състезавай за наградния фонд.',
    robots: 'index, follow',
  },
  '/rules': {
    title: 'Правила на белота – карти, анонси и точкуване | Pika.bg',
    description:
      'Подробни правила на белота: раздаване, наддаване, сила на картите, анонси, белот, контра, реконтра, капо и край на партията.',
    robots: 'index, follow',
  },
  '/strategy': {
    title: 'Съвети и стратегии за белот | Pika.bg',
    description:
      'Практически съвети за по-добра игра на белот: наддаване, теглене на козове, броене на картите, партньорска игра и стратегия на без коз.',
    robots: 'index, follow',
  },
  '/terms': {
    title: 'Общи условия | Pika.bg',
    description:
      'Общи условия за използване на Pika.bg, регистрация, участие в игри, виртуални жълтици, плащания и правила за поведение.',
    robots: 'index, follow',
  },
  '/privacy': {
    title: 'Политика за поверителност | Pika.bg',
    description:
      'Информация за обработването и защитата на личните данни на потребителите на Pika.bg.',
    robots: 'index, follow',
  },
  '/contact': {
    title: 'Контакти и поддръжка | Pika.bg',
    description:
      'Свържи се с екипа на Pika.bg за помощ, въпроси, сигнали или обратна връзка относно платформата.',
    robots: 'index, follow',
  },
  '/learn': {
    title: 'Научи белот – основи за начинаещи | Pika.bg',
    description:
      'Научи основите на белота: какво е играта, защо е отборна, как протича наддаването и разиграването, и накъде да продължиш след първите стъпки.',
    robots: 'index, follow',
  },
  '/faq': {
    title: 'Често задавани въпроси | Pika.bg',
    description:
      'Отговори на чести въпроси за регистрация, игра като гост, жълтици, бонуси, ботове, честно раздаване, напускане на игра и плащания в Pika.bg.',
    robots: 'index, follow',
  },
  '/about': {
    title: 'За Pika.bg – онлайн платформа за белот',
    description:
      'Pika.bg е онлайн платформа за забавление с белот. Жълтиците са виртуална игрова валута без парична стойност. Виж целта и принципите на платформата.',
    robots: 'index, follow',
  },
  '/fair-play': {
    title: 'Честна игра | Pika.bg',
    description:
      'Как работи случайното раздаване на карти, каква е ролята на ботовете и защо измамите, злоупотребите и договорената игра са забранени в Pika.bg.',
    robots: 'index, follow',
  },
}

const NOINDEX_ROBOTS = 'noindex, nofollow'

function getConfig(pathname: string): RouteSeoConfig {
  return (
    ROUTE_SEO[pathname] ?? {
      title: 'Pika.bg – Белот онлайн с реални играчи',
      description:
        'Играй белот онлайн в Pika.bg. Избери маса, състезавай се с реални играчи и развивай своя профил, ранг и статистика.',
      robots: NOINDEX_ROBOTS,
    }
  )
}

function getMeta(name: string): HTMLMetaElement {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.name = name
    document.head.appendChild(el)
  }
  return el
}

function getOgMeta(property: string): HTMLMetaElement {
  let el = document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute('property', property)
    document.head.appendChild(el)
  }
  return el
}

function getCanonical(): HTMLLinkElement {
  let el = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  if (!el) {
    el = document.createElement('link')
    el.rel = 'canonical'
    document.head.appendChild(el)
  }
  return el
}

export function applyRouteSeo(pathname?: string): void {
  const path = pathname ?? window.location.pathname
  const cfg = getConfig(path)
  const canonicalUrl = BASE_URL + (path === '/' ? '/' : path)

  document.title = cfg.title

  getMeta('description').content = cfg.description
  getMeta('robots').content = cfg.robots

  getCanonical().href = canonicalUrl

  getOgMeta('og:title').content = cfg.title
  getOgMeta('og:description').content = cfg.description
  getOgMeta('og:url').content = canonicalUrl
}
