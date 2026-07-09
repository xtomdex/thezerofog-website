# Archived: /waitlist/ pages (removed from build 2026-07-09)

CEO decision 2026-07-09: waitlist-страница не нужна в фанеле - убрана из билда,
но наработки сохранены (headline-вариант "The 4-Week Protocol That Removed My Brain
Fog And Let Me Do Real Work Again", bullets, steps-блок, credibility-блок).

Files:
- `waitlist.njk` - opt-in страница (была /waitlist/)
- `waitlist-confirmed.njk` - thank-you после подписки (была /waitlist-confirmed/)
- `waitlist.css`, `waitlist-confirmed.css` - стили
- `waitlist.js` - optin POST с source=waitlist

Если возвращать: git mv обратно в src/ + вернуть redirects в netlify.toml
(/social -> /waitlist/) + у Димы MailerLite-группа Waitlist (см.
`/Users/Cyrill/.claude/projects/-Users-Cyrill-AI-SANDBOX-Agent-Teams/memory/project_todo_mailerlite_social_rename.md`).
