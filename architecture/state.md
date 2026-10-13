# Состояние

Код: `src/core/types.ts`, `src/core/defaults.ts`, `src/core/phrase.ts`.

Числа в сцене нормализованы. Подписи экрана (`P13`, `1/16`, `Snap`) живут в UI.

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

Chords: `change`, `length`, `motion`, `variation`, `mood`, `tension`, прямая страница `play`, восемь sound-модуляторов.

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

`HarmonicEvent` — `startTick`, `lengthTicks`, `root` (ступень), `quality` (0..7: maj, min, sus2, sus4, 7, m7, dim, aug). Bass и Lead квантуют желаемую ступень к тонам этого аккорда на величину `follow`. Направление arp на их ноты не влияет.

Генерация фразы и preview — одна функция `generatePhrase`.
