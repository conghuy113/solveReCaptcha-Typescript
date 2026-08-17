// SPDX-License-Identifier: AGPL-3.0-only

const groups: ReadonlyArray<readonly [classId: number, labels: readonly string[]]> = [
  [0, ["bicycle", "bicycles", "велосипеды", "自行车", "bicicletas", "vélos", "fahrrädern", "fietsen", "biciclette"]],
  [1, ["bridge", "bridges", "мостами", "桥", "puentes", "ponts", "brücken", "bruggen", "ponti", "pontes"]],
  [2, ["bus", "buses", "автобус", "公交车", "autobuses", "autobús", "bussen", "autobus", "ônibus"]],
  [3, ["car", "cars", "automobile", "taxi", "taxis", "автомобили", "такси", "小轿车", "出租车", "coches", "voitures", "pkws", "auto's", "auto", "carros", "táxis"]],
  [4, ["chimney", "chimneys", "дымовые трубы", "烟囱", "chimeneas", "cheminées", "schornsteinen", "schoorstenen", "camini", "chaminés"]],
  [5, ["crosswalk", "crosswalks", "пешеходные переходы", "人行横道", "过街人行道", "pasos de peatones", "passages pour piétons", "fußgängerüberwegen", "oversteekplaatsen", "zebrapaden", "strisce pedonali", "faixas de pedestres", "faixas de pedestre"]],
  [6, ["a fire hydrant", "fire hydrant", "fire hydrants", "hydrant", "hydrants", "гидрантами", "пожарные гидранты", "消防栓", "bocas de incendios", "una boca de incendios", "borne d'incendie", "bouches d'incendie", "hydranten", "feuerhydranten", "een brandkraan", "brandkranen", "idrante", "idranti", "um hidrante", "hidrantes"]],
  [7, ["motorcycle", "motorcycles", "мотоциклы", "摩托车", "motocicletas", "motos", "motorrädern", "motorfietsen", "motoren", "motocicli"]],
  [8, ["mountain", "mountains", "mountains or hills", "горы или холмы", "montañas o colinas", "montagnes ou collines", "berge oder hügel", "bergen of heuvels", "montagne o colline", "montanhas ou colinas"]],
  [10, ["palm", "palm tree", "palm trees", "пальмы", "棕榈树", "palmeras", "palmiers", "palmen", "palmbomen", "palme", "palmeiras"]],
  [11, ["stair", "stairs", "лестницы", "楼梯", "escaleras", "escaliers", "treppen", "treppenstufen", "trappen", "scale", "escadas"]],
  [12, ["tractor", "tractors", "трактора", "拖拉机", "tractores", "tracteurs", "traktoren", "tractoren", "trattori", "tratores"]],
  [13, ["traffic", "traffic light", "traffic lights", "traffic_lights", "светофоры", "红绿灯", "semáforos", "feux de circulation", "ampeln", "verkeerslichten", "semafori"]],
];

const mappings = new Map(
  groups.flatMap(([classId, labels]) => labels.map((label) => [label.trim().toLowerCase(), classId] as const)),
);

export function classificationTargetClass(keyword: string): number | undefined {
  const normalized = keyword.trim().toLowerCase();
  const exact = mappings.get(normalized);
  if (exact !== undefined) return exact;
  for (const [label, classId] of mappings) {
    if (normalized.includes(label) || label.includes(normalized)) return classId;
  }
  return undefined;
}
