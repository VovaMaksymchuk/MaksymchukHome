// ⚙️ Firebase console → Project settings → General → Your apps → Web app → SDK config
export const firebaseConfig = {
  apiKey: "AIzaSyBNK5mI8U2lYV1Dj8Rm81k8uZTm06-A1ec",
  // Порада: постав сюди домен хостингу (YOUR-PROJECT.web.app) — тоді вхід
  // через Google на iPhone/Safari працює стабільніше (redirect на тому ж домені).
  authDomain: "maksymchukhome.firebaseapp.com",
  databaseURL: "https://maksymchukhome-default-rtdb.europe-west1.firebasedatabase.app/",
  projectId: "maksymchukhome",
  appId: "1:713527524021:web:2693f15cd726ab13b4dcfc",
};

// Параметри квартири
export const settings = {
  title: "Квартира",
  batteryKWh: 5.12,      // Growatt Hope 5.0L-B1, 51.2 В · 5.12 кВт·год
  reserveSoc: 20,        // % — нижче цього інвертор вимикає вихід (cut-off)
  inverterW: 6200,       // номінал інвертора, Вт
  staleAfterSec: 120,    // дані старші за це — вважаємо HA офлайн
  historyHours: 24,      // скільки годин показувати на графіках
  pinKeyboard: "numeric", // "numeric" — цифрова клавіатура для пароля, "text" — звичайна
};

// Розумний будинок (Tuya через HA) — списки для вкладок «Світло»/«Стан».
// id тут — лише ключ у Firebase (home/switches/<id>, home/sensors/.../<id>);
// реальні entity_id мапляться в HA-пакеті (⚙️ homeassistant/packages/smart_home.yaml).
export const rooms = [
  { id: "living", label: "Вітальня" },
  { id: "bedroom", label: "Спальня" },
  { id: "office", label: "Кабінет" },
  { id: "hallway", label: "Коридор" },
];

export const climateDevices = [
  { id: "boiler", label: "Котел" },
  { id: "floor", label: "Тепла підлога", toggle: true }, // можна повністю вимкнути, не лише ціль
];

export const sensorGroups = {
  leak: [
    { id: "bathroom", label: "Ванна" },
    { id: "kitchen", label: "Кухня" },
  ],
  smoke: [
    { id: "kitchen", label: "Кухня" },
    { id: "hallway", label: "Коридор" },
  ],
};



