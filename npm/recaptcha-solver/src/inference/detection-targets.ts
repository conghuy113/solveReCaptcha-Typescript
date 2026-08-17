// SPDX-License-Identifier: AGPL-3.0-only

const groups: ReadonlyArray<readonly [classId: number, labels: readonly string[]]> = [
  [
    1,
    [
      "bicycle", "bicycles", "велосипеды", "自行车", "bicicletas", "vélos",
      "Fahrrädern", "fietsen", "biciclette",
    ],
  ],
  [
    2,
    [
      "car", "cars", "automobile", "taxi", "taxis", "автомобили", "小轿车",
      "coches", "voitures", "Pkws", "auto's", "auto", "carros", "такси",
      "出租车", "Taxis", "taxi's", "táxis",
    ],
  ],
  [
    3,
    [
      "motorcycle", "motorcycles", "мотоциклы", "摩托车", "motocicletas",
      "motos", "Motorrädern", "motorfietsen", "motoren", "motocicli",
    ],
  ],
  [
    5,
    [
      "bus", "buses", "автобус", "公交车", "autobuses", "autobús", "Bus",
      "Bussen", "bussen", "autobus", "ônibus",
    ],
  ],
  [8, ["boat", "boats", "лодки", "船", "barcos", "bateaux", "Boote", "boten", "barche"]],
  [
    9,
    [
      "traffic", "traffic light", "traffic lights", "traffic_lights", "светофоры",
      "红绿灯", "semáforos", "feux de circulation", "Ampeln", "verkeerslichten",
      "semafori",
    ],
  ],
  [
    10,
    [
      "a fire hydrant", "fire hydrant", "fire hydrants", "hydrant", "hydrants",
      "гидрантами", "пожарные гидранты", "消防栓", "bocas de incendios",
      "una boca de incendios", "borne d'incendie", "bouches d'incendie",
      "Hydranten", "Feuerhydranten", "een brandkraan", "brandkranen", "idrante",
      "idranti", "um hidrante", "hidrantes",
    ],
  ],
  [
    12,
    [
      "parking meters", "парковочные автоматы", "停车计时器",
      "parquímetros", "parcmètres", "Parkometern", "parkeermeters", "parchimetri",
    ],
  ],
];

export const COCO_TARGET_MAPPINGS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    groups.flatMap(([classId, labels]) => labels.map((label) => [label.trim().toLowerCase(), classId])),
  ),
);

export function detectionTargetClass(keyword: string): number | undefined {
  return COCO_TARGET_MAPPINGS[keyword.trim().toLowerCase()];
}
