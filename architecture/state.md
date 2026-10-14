# Состояние

Код: `src/core/types.ts`, `src/core/defaults.ts`, `src/core/phrase.ts`, `src/core/persist.ts`.

Числа в сцене нормализованы. Подписи экрана (`P13`, `1/16`, `Snap`) живут в UI.

Пока проект один: целиком пишется в `/data/UserData/schwung/ptnmove/project.json` (вне каталога модуля, чтобы deploy не затирал). Сохранение — `onUnload` и debounce ~2 с после изменений; `init` поднимает файл или defaults. Morph и `wanderOriginTick` на диск не живут (сбрасываются); context/page/mode UI восстанавливаются.

## Коробки

- **Scene** — неизменяемый снимок семи lane. Идентификатор `001`, `002`, … При Record сцена получает псевдослучайный цвет пэда из яркой палитры Move, он хранится на сцене. Journal только дописывается.
- **Working** — живой документ той же формы. Морф пишет в него. Энкодер пишет сразу и снимает это поле с морфа. Record копирует working.
- **Project** — journal, sets (до 32 ссылок на сцены), mixer (7 уровней и master), global, macro offsets, 4 bookmark'а, mute, lock, transition, wander, clipboard. В сцену это не входит.

`heard = clamp(stored + macroOffset)` считается в момент генерации фразы. Record offset не запекает. У locked lane offset не применяется.

Mute убирает lane из слышимого выхода. Harmonic events Chords при mute остаются, bass и lead продолжают их читать.

## Lane

Ударные и Bass/Lead: два параллельных евклида `gen1` / `gen2` (`length`, `hits`, `rotate`, `probability`, `velocity` V/P/C/A), без Form и без A/B.

Ударные дополнительно: `ratchet.count/rate`, восемь sound-модуляторов.

Bass и Lead дополнительно: `follow`, `degree`, `range`, `length` (длительность ноты), `repeat`, `step`, восемь sound-модуляторов. Отдельного lane.velocity нет — громкость из `gen*.velocity`.

Chords: `start`, `count`, `length` (доля 0..4: шестнадцатая, восьмая, доля, полтакта, такт), `motion`, `variation`, `mood`, `tension`, `way`, генераторы `rate` / `gate`, прямые `spread`, `flow`, `octaves`, `direction`, восемь sound-модуляторов. `rate` 0 — блок; (0, 1] — арпеджио от 1/8 до 1/64, длина ноты `gate` на шаг. `rate` и `gate` читаются на каждой ноте арпеджио; блок проверяется раз в шестнадцатую, так что фигура может смениться внутри аккорда. `direction`: 0 вверх, 1 вниз, 2 через аккорд, 3 вверх-вниз, 4 вниз-вверх, 5 с краёв, 6 из середины, 7 случайно от seed. Макрос `length` на аккорды не действует.

Метр — `global.bar`. `follow` только у bass/lead.

Евклид:

```text
phraseSteps = max(length1, length2)   // length 0 = off
local = step mod length
pattern = rotate(euclid(hits, length))
if hash(seed, lane, gen, step) >= probability → skip hit
```

`probability` 1 оставляет все удары кольца, 0 глушит генератор. Короткое кольцо повторяется внутри более длинной петли. На одном шаге оба попали → одно событие, velocity = max.

Модулятор (полный V/P/C/A), в том числе у gen.velocity:

```text
cycle = max(1, round(cycle))
phase = (step mod cycle) / cycle
out = clamp(value + motif(pattern, phase) * amount)
```

`step` — позиция в шестнадцатых. Генератор идёт сам по себе и не считает note on. Нота, ratchet и повтор читают значение в свой момент. Звуковые параметры вроде фильтра голос читает заново на каждом сэмпле, пока нота звучит. `amount = 0` оставляет центр. Сцена хранит id мотива. Форма — `motif(id, phase)` версии `MOTIF_BANK_VERSION` (сейчас 1), 64 формы.

## Clock

192 PPQN. Темп и swing в Global. Swing 0 прямой; swing 1 задерживает нечётные шестнадцатые на половину шестнадцатой уже после сетки генератора. Фраза каждого lane играется по кругу на своей длине. Ход ведёт `dsp.so` по аудиоблокам, поэтому темп не зависит от того, как часто интерфейс успевает перерисоваться.

Хеш вероятности: `seed + lane + generator + "prob" + step`. Идентификатора сцены в хеше нет.

Ratchet и Repeat считают исходное событие за единицу: count 1 — одно событие. Повторы Repeat сдвигаются на `step` ступеней лада.

## Гармония

`HarmonicEvent` — `startTick`, `lengthTicks`, `root` (ступень), `quality` (0..7: maj, min, sus2, sus4, 7, m7, dim, aug). Длины сидят на сетке долей такта и в сумме равны фразе. `variation` выше нуля укорачивает часть аккордов до проходящих, время забирает сосед. Качество одно на фразу, из `mood` и `tension`. Bass и Lead квантуют желаемую ступень к тонам этого аккорда на величину `follow`. Порядок голосов аккорда на их ноты не влияет.

Генерация фразы и preview — одна функция `generatePhrase`.
