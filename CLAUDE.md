# Home Dashboard — контекст проєкту

Мобільний дашборд квартири (Софіївська Борщагівка, вул. Січова 30/53 → ДТЕК КРЕМ, Київщина).
Home Assistant (локальний, RPi 5) сам пушить дані у Firebase Realtime Database через `rest_command`;
дашборд на Firebase Hosting читає їх наживо. Без збірки: чистий ES-modules JS, Firebase JS SDK 12.18.0 з gstatic.

## Залізо
- Інвертор Anenji 6.2 кВт 48 В, у HA через інтеграцію EyeBond Local (ha-eybond-local)
- Батарея Growatt Hope 5.0L-B1 (51.2 В, 5.12 кВт·год), BMS-зв'язок у режимі Li2
- АВР: мережа живить квартиру напряму, інвертор — лише при відключенні
  → при світлі навантаження інвертора ≈ 0 (це нормально)
- Без сонячних панелей, заряд лише від мережі

## Структура
- `public/` — дашборд: `app.js` (рендер), `logic.js` (чисті обчислення, тестуються в Node),
  `data.js` (Firebase), `config.js` (конфіг Firebase і параметри квартири), `styles.css`
- `database.rules.json` — правила RTDB: читання для Google-акаунтів з `access/viewers` або за PIN;
  запис у `/home` лише HA-користувачу з `access/writers`
- `homeassistant/packages/home_dashboard.yaml` — пакет HA (позначки ⚙️ = що заповнити)
- `tools/test_push.sh` — тестовий запис без HA; `tools/pin_hash.sh` — хеш пароля для `pin/hash`

## Вхід
- Google (allowlist uid у `access/viewers`) АБО простий пароль: анонімний Firebase-юзер +
  SHA-256("projectId:пароль") у `pin_try/<uid>`; порівнюється з `pin/hash` у правилах.
- Блокування контролюють правила (`pin_guard`): 3 спроби → 1 хв, далі ×2 до 24 год, глобально.
  Перевірка пароля можлива лише в одному атомарному update із записом «спроби».
- Правила НЕ перевірені в емуляторі (у попередньому середовищі він не завантажувався) —
  варто прогнати `firebase emulators:start --only database` + @firebase/rules-unit-testing.

## Перегляд
- `python3 -m http.server -d public 8080` → локальна копія (читає живу базу Firebase)

## Що далі (TODO)
1. Знайти чергу/підчергу ДТЕК КРЕМ для Січова 30/53 (dtek-krem.com.ua/ua/shutdowns) і
   поки HA не підключений — показувати реальний графік на дашборді з тестовими даними інвертора.
   У HA потім: інтеграція Svitlo Yeah або ha-dtek (обидві підтримують Київщину) → calendar entity.
2. Підставити справжні entity_id EyeBond у пакет HA (зараз орієнтовні `sensor.anenji_*`).
3. Створити Firebase-проєкт, заповнити `config.js` і `.firebaserc`, `firebase deploy`.
