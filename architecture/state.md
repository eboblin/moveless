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

Ударные: `events.a/b` по два генератора `level/cycle/offset`, `form`, `ratchet.count/rate`, восемь sound-модуляторов.

Bass и Lead: те же events и form, плюс `degree`, `range`, `length`, `velocity`, `repeat`, `step`.

Chords: `change`, `length`, `motion`, `variation`, `mood`, `tension`, прямая страница `play`, восемь sound-модуляторов.

`Form.bar` нет. Метр — `global.bar`. `follow` есть у всех lane; на ритм ударных не влияет.

Модулятор:

```text
cycle = max(1, round(cycle))
phase = (step mod cycle) / cycle
out = clamp(value + motif(pattern, phase) * amount)
```

`step` — позиция в шестнадцатых. Генератор идёт сам по себе и не считает note on. Нота, ratchet и повтор читают значение в свой момент. Звуковые параметры вроде фильтра голос читает заново на каждом сэмпле, пока нота звучит. `amount = 0` оставляет центр. Сцена хранит id мотива. Форма — `motif(id, phase)` версии `MOTIF_BANK_VERSION` (сейчас 1), 64 формы.

## Clock

192 PPQN. Темп и swing в Global. Swing 0 прямой; swing 1 задерживает нечётные шестнадцатые на половину шестнадцатой уже после сетки генератора. Фраза каждого lane играется по кругу на своей длине. Ход ведёт `dsp.so` по аудиоблокам, поэтому темп не зависит от того, как часто интерфейс успевает перерисоваться.

Хеш вероятности: `seed + lane + part + generator + variationIndex + step`. Идентификатора сцены в хеше нет.

Два генератора части A или B дают объединение сеток: один шаг — не больше одного исходного события. Шаг сетки — шестнадцатая. Cycle 1 ставит событие на каждую 1/16, cycle 4 — на каждую четверть. Variation сдвигает level и offset, звук не трогает. Индекс 0 — база.

Ratchet и Repeat считают исходное событие за единицу: count 1 — одно событие. Повторы Repeat сдвигаются на `step` ступеней лада.

## Гармония

`HarmonicEvent` — `startTick`, `lengthTicks`, `root` (ступень), `quality` (0..7: maj, min, sus2, sus4, 7, m7, dim, aug). Bass и Lead квантуют желаемую ступень к тонам этого аккорда на величину `follow`. Направление arp на их ноты не влияет.

Генерация фразы и preview — одна функция `generatePhrase`.
