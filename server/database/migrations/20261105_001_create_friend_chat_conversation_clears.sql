-- Лични чатове: окончателно изтриване на целия разговор (за двамата).
--
-- Съобщенията, снимките и маркерите за прочитане се трият физически
-- (chatStore.deleteConversation). Тук остава само минималният маркер за
-- събитието — кой участник и кога е изтрил разговора — за да види другият
-- участник „<име> изтри този чат.“, дори ако е бил офлайн. Без никакво
-- съдържание от изтритите съобщения.
--
-- Един ред на разговор (последното изтриване). Редът изчезва при първото
-- ново съобщение в разговора (chatStore.sendMessage) и заедно с
-- profile_friendships реда (ON DELETE CASCADE — напр. при изтриване на профил).
-- Името не се пази тук — показва се текущото публично име на профила.

CREATE TABLE IF NOT EXISTS friend_chat_conversation_clears (
  friendship_id TEXT PRIMARY KEY,
  cleared_by_profile_id TEXT NOT NULL,
  cleared_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (friendship_id) REFERENCES profile_friendships(friendship_id) ON DELETE CASCADE
);
