const ADJECTIVES = [
  "весёлый",
  "ловкий",
  "мудрый",
  "крошечный",
  "смелый",
  "молчаливый",
  "сияющий",
  "смешной",
  "быстрый",
  "мечтательный",
  "нежный",
  "дерзкий",
  "улыбчивый",
  "яркий",
  "сонный",
  "бодрый",
  "любопытный",
  "задумчивый",
  "пушистый",
  "озорной",
];

const ANIMALS = [
  "панда",
  "лисица",
  "котёнок",
  "енот",
  "хомяк",
  "дельфин",
  "жираф",
  "капибара",
  "барсук",
  "коала",
  "выдра",
  "павлин",
  "щенок",
  "улитка",
  "ежиха",
  "сурикат",
  "жук",
  "морж",
  "сова",
  "пингвин",
];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function getChatDisplayName(chatId) {
  const hash = hashString(chatId);
  const adjective = ADJECTIVES[hash % ADJECTIVES.length];
  const animal = ANIMALS[(hash >> 8) % ANIMALS.length];
  return `${adjective} ${animal}`;
}
