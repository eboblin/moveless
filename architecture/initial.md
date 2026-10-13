content = r'''# Архитектура проекта



Ниже соберу это как \*\*снимок текущей архитектуры\*\*, уже почти в форме исходника для ТЗ. Я буду явно разделять то, что мы \*\*зафиксировали\*\*, и то, что пока является \*\*рабочей схемой / требует решения\*\*, чтобы другой агент не принял случайные старые идеи за требования.



\---



\# 1. Что это за инструмент



Проект — самостоятельный \*\*генеративный performance-инструмент для Ableton Move поверх Schwung/takeover\*\*, вдохновлённый PTNSHIFT, но не его буквальная копия.



Главные идеи:



\- музыка задаётся \*\*параметрически\*\*, а не step-sequencer'ом;

\- пользователь видит и редактирует \*\*музыкальные поведения\*\*, а не вручную расставляет ноты по шагам;

\- состояние полностью воспроизводимо;

\- сцены можно сохранять, отбирать в Set и морфить между ними;

\- практически любой интересный scalar-параметр может сам иметь повторяющийся рисунок изменения;

\- экран постоянно показывает \*\*результат генератора\*\*, а не только числа;

\- интерфейс должен быть достаточно простым для быстрого использования, но \*\*не игрушечным\*\*: опытному пользователю должно быть куда копать.



\*\*Step editor специально не нужен.\*\*



\---



\# 2. Главная терминология



Очень важно не смешивать `Pattern` в разных смыслах.



\## Working Scene



Текущее живое редактируемое состояние всего инструмента.



Содержит состояния всех музыкальных lane:



```text

Working Scene

├ Kick

├ Snare

├ Hat

├ Perc

├ Bass

├ Lead

└ Chords

```



Пока пользователь крутит ручки, меняется именно Working Scene.



\---



\## Scene



\*\*Immutable snapshot всей Working Scene.\*\*



Scene — основной сохраняемый музыкальный объект.



Не отдельный Bass pattern, не отдельный Kick pattern, а целиком состояние всех lane.



```text

Scene 042

├ Kick state

├ Snare state

├ Hat state

├ Perc state

├ Bass state

├ Lead state

└ Chords state

```



`Record` всегда создаёт \*\*новую Scene\*\*.



Никакого overwrite обычной командой Save/Record.



\---



\## Journal



История всех сохранённых Scene проекта.



```text

Journal

├ Scene 001

├ Scene 002

├ Scene 003

...

```



Это именно журнал найденных состояний.



Если Journal разрастается, проблему решает уровень Project/cleanup, а не изменение семантики Save.



\---



\## Set



Curated-набор \*\*ссылок на целые Scene\*\*.



```text

Set A

├ → Scene 014

├ → Scene 031

├ → Scene 052

└ ...

```



Set \*\*не содержит per-lane pools\*\*.



В Set нельзя отдельно «добавить Bass pattern».



Один lane — просто составная часть Scene.



\---



\## Pattern в параметре



Совсем другая сущность:



```text

VALUE / PATTERN / CYCLE / AMOUNT

```



Здесь `Pattern` — \*\*форма модуляционного рисунка конкретного параметра\*\*.



Это не Scene и не сохранённый музыкальный паттерн.



Для ТЗ я бы в коде вообще называл это чем-то вроде:



```text

ModPattern

```



чтобы не путаться со Scene.



\---



\# 3. Project



Мета-уровень:



```text

Project

├ Journal

├ Sets

├ Global Settings

└ Project-level state

```



\## Зафиксировано



`Record`:



```text

Working Scene

&#x20;    ↓ RECORD

new immutable Scene

&#x20;    ↓

Journal

```



Всегда создаётся новый объект.



Если пользователь:



```text

Recall Scene 17

→ изменил одну ручку

→ Record

```



получается Scene 18.



Scene 17 остаётся нетронутой.



\---



\# 4. Семь музыкальных lane



Текущий состав:



```text

1 Kick

2 Snare

3 Hat

4 Perc

5 Bass

6 Lead

7 Chords

```



Раньше drums были одним lane. От этого отказались.



Теперь каждый drum voice — \*\*полноценный самостоятельный lane\*\*.



Это существенно упрощает архитектуру и делает генеративную модель единообразной.



\---



\# 5. Chords имеет двойную роль



Chords — не служебный harmony track, а полноценный звучащий музыкальный lane.



Он:



1\. сам генерирует и играет аккорды;

2\. публикует harmonic context для Bass и Lead.



Схематично:



```text

Chords generator

&#x20;      │

&#x20;      ├──→ Chords synth → audio

&#x20;      │

&#x20;      └──→ Harmonic Context

&#x20;             ├──→ Bass

&#x20;             └──→ Lead

```



Если Chords не хочется слышать, его уровень можно убрать в ноль / замьютить, но harmonic context при этом может продолжать существовать.



Bass/Lead не должны следовать фактическому MIDI voicing Chords. Им передаётся \*\*абстрактная гармония\*\*, например chord/root/scale context.



\---



\# 6. Два фундаментально разных генератора



Это одна из самых важных архитектурных идей проекта.



\## 6.1 EVENT GENERATOR



Отвечает на вопрос:



> \*\*Когда возникает событие?\*\*



Базовая структура:



```text

EVENT GENERATOR



PART A

&#x20; Generator 1:

&#x20;   Level

&#x20;   Cycle

&#x20;   Offset



&#x20; Generator 2:

&#x20;   Level

&#x20;   Cycle

&#x20;   Offset



PART B

&#x20; Generator 1:

&#x20;   Level

&#x20;   Cycle

&#x20;   Offset



&#x20; Generator 2:

&#x20;   Level

&#x20;   Cycle

&#x20;   Offset

```



Итого:



```text

Level / Cycle / Offset

× 2 generators

× A/B sections

```



Эта модель может быть \*\*одинаковой для Kick, Snare, Hat, Perc, Bass и Lead\*\*.



Chords — исключение, потому что harmonic progression имеет дополнительную семантику.



\---



\## 6.2 PARAMETER MODULATOR



Отвечает на вопрос:



> \*\*Как конкретный параметр меняется во времени?\*\*



У большинства параметров четыре элемента:



```text

VALUE

PATTERN

CYCLE

AMOUNT

```



Смысл:



\- \*\*VALUE\*\* — базовое / центральное значение;

\- \*\*PATTERN\*\* — форма повторяющегося модуляционного рисунка;

\- \*\*CYCLE\*\* — длина этого рисунка;

\- \*\*AMOUNT\*\* — сила влияния Pattern на Value.



Сокращённая запись:



```text

V / P / C / A

```



\### Pattern



Pattern намеренно может оставаться немного «чёрным ящиком».



Пользователь крутит:



```text

P01

P02

P03

...

```



и видит форму глазами и слышит результат.



Это лучше скрытого seed, потому что конкретный motif становится \*\*прямой редактируемой координатой состояния\*\*.



Старая идея со скрытым per-parameter seed и `Capture+touch → reroll motif` \*\*устарела после появления явного Pattern\*\*.



\---



\# 7. Важное разделение: EVENT vs PARAMETER



Пример для Kick:



```text

EVENT GENERATOR

→ решает, в какие моменты есть kick hit



PARAMETER MODULATORS

→ Pitch

→ Decay

→ Boom

→ Snap

→ etc.

```



Пример для Bass:



```text

EVENT GENERATOR

→ когда появляется bass note



дальше:

pitch/harmony logic

parameter modulation

synth

```



То есть нельзя пытаться сделать drum rhythm через `V/P/C/A`: для этого есть отдельный EVENT GENERATOR.



\---



\# 8. Общая философия страниц



Цель — \*\*не больше примерно 8 страниц на lane\*\*.



Рабочая дисциплина:



```text

Pages 1–4  = PATTERN / musical generation

Pages 5–8  = SOUND

```



Это важно и для навигации: одна строка из восьми pad'ов может напрямую адресовать любую страницу lane.



Не нужно искусственно делать одинаковые параметры у разных lane.



Нужна одинаковая \*\*логика интерфейса\*\*, а содержимое должно соответствовать инструменту.



\---



\# 9. Drum PATTERN pages



Для всех четырёх drum lane структура сейчас:



```text

1 EVENT A

2 EVENT B

3 FORM / VARIATION

4 RATCHET

```



\---



\## Page 1 — EVENT A



Direct controls:



```text

G1 Level

G1 Cycle

G1 Offset



G2 Level

G2 Cycle

G2 Offset

```



\### G1 Level



Сила / вероятность проявления первого event-generator.



\### G1 Cycle



Период первого генератора.



Например four-on-the-floor Kick:



```text

Cycle = 4

Offset = 0

Level = 100

```



на шестнадцатой сетке.



\### G1 Offset



Фаза генератора относительно его Cycle.



\### G2 Level / Cycle / Offset



Второй независимый генератор.



Обычно даёт:



\- дополнительные удары;

\- syncopation;

\- полиритмию;

\- fills;

\- более длинный composite pattern.



Пример:



```text

G1 100 / 4 / 0

G2  55 / 7 / 5

```



\---



\# 10. EVENT B



Та же структура:



```text

G1 Level

G1 Cycle

G1 Offset



G2 Level

G2 Cycle

G2 Offset

```



Но B — альтернативная часть внутренней формы того же lane.



Пример:



```text

A = основной groove

B = более активная концовка / fill

```



A/B — не две Scene и не два saved pattern. Это части внутреннего event generator.



\---



\# 11. FORM / VARIATION



Текущий подробный вариант — \*\*рабочий, но параметры ещё можно пересматривать\*\*.



Предлагалась direct-8 страница:



```text

Length

Bar

A/B Split

Repeats



Var Every

Var Div

Var Count

Var Amount

```



\### Length



Общая длина формы lane.



\### Bar



Внутренняя метрическая единица формы.



\### A/B Split



Где внутри формы A сменяется B.



Например:



```text

75%

```



→ первые 3/4 формы A, последняя четверть B.



\### Repeats



Сколько раз большая A/B-структура повторяется.



\### Var Every



Как часто запускается variation.



\### Var Div



В каких единицах считать `Var Every`.



\### Var Count



Сколько разных variation states может использоваться.



\### Var Amount



Насколько далеко variation отклоняется от базы.



Ключевой принцип:



\*\*Variation меняет event structure, а не звук.\*\*



То есть она отвечает за:



\- наличие / отсутствие hit;

\- проявление дополнительных событий;

\- изменение комбинации G1/G2.



Pitch/Decay/etc. остаются отдельными Parameter Modulators.



\---



\# 12. Drum RATCHET



Page 4 у Kick/Snare/Hat/Perc.



Два параметра:



```text

COUNT

V / P / C / A



RATE

V / P / C / A

```



\## Count



Количество hits, создаваемых из одного event:



```text

1 = обычное событие

2 = double

3 = triple

4 = четыре удара

...

```



`Count = 1` фактически ratchet off.



Поскольку сам Count модулируется через Pattern/Cycle/Amount, отдельный `Chance` не нужен.



Пример результирующего поведения:



```text

1 1 1 2 1 1 3 1 ...

```



\---



\## Rate



Внутренняя скорость ratchet.



Музыкально квантованные значения, например:



```text

1/8

1/16

1/16T

1/32

1/32T

1/64

...

```



Rate тоже `V/P/C/A`.



\---



\# 13. Bass / Lead Page 4



Вместо Ratchet:



```text

REPEAT

```



Два параметра:



```text

REPEAT

V / P / C / A



STEP

V / P / C / A

```



\## Repeat



Сколько повторных note events сделать внутри одного исходного event.



\## Step



Насколько pitch каждого следующего repeat сдвигается относительно предыдущего, желательно в scale-relative units.



Примеры:



```text

Step = 0

→ та же нота



Step = +1

→ движение вверх по scale



Step = -1

→ вниз



Step = octave-equivalent

→ octave bass / octave lead

```



Эта страница может делать:



\- retrigger;

\- ostinato;

\- octave bass;

\- rising/falling repeats;

\- мини-arpeggio;

\- trance-like repeat figures.



Общая семантика Page 4:



> \*\*как уже triggered event разворачивается внутри себя.\*\*



У drums это Ratchet.



У Bass/Lead — Repeat.



У Chords — Arp/Strum Play.



\---



\# 14. Chords Pattern pages



Chords специализирован.



Текущая компактная схема:



```text

1 RHYTHM

2 MOVE

3 HARMONY

4 PLAY

```



\---



\## Chords — RHYTHM



Два модулируемых параметра:



```text

Change

Length

```



`Change` — как часто меняется гармония.



`Length` — сколько длится chord event.



Оба потенциально `V/P/C/A`.



\---



\## Chords — MOVE



```text

Motion

Variation

```



\### Motion



Насколько активно progression перемещается по harmonic space.



\### Variation



Насколько маршрут меняется между проходами.



\---



\## Chords — HARMONY



```text

Mood

Tension

```



\### Mood



Простой человеческий параметр общей гармонической окраски.



Под капотом может влиять на scale/mode/chord pool, но пользователь не должен работать с академической терминологией.



\### Tension



Устойчивые простые consonant states ↔ более напряжённые harmonic states.



Ранее были сформулированы и другие понятные Chords-оси:



```text

Mood

Motion

Tension

Change

Spread

Flow

Density

Variation

```



Это остаётся полезной семантической моделью, даже если часть параметров распределена по другим страницам.



\---



\# 15. Chords PLAY



Это direct-8 страница, Elektron-style:



```text

Mode

Rate

Gate

Octaves



Spread

Flow

Strum

Direction

```



\## Mode



Например:



```text

Chord

Arp

Strum

Hybrid

```



\## Rate



Скорость arp/retrigger.



\## Gate



Длина отдельных notes внутри arp.



\## Octaves



Сколько октав охватывает arp.



\## Spread



Ширина chord voicing.



\## Flow



Насколько плавно голоса переходят от одного chord к другому; human-friendly voice leading.



\## Strum



Временной разброс голосов chord.



\## Direction



Направление arp/strum:



```text

up

down

alternate

...

```



Важно:



```text

Harmony identity

&#x20;    ↓

Voicing

&#x20;    ↓

Arp / Strum

&#x20;    ↓

Synth

```



Bass/Lead следуют harmony \*\*до Arp/Strum\*\*, а не фактически прозвучавшим arp notes.



\---



\# 16. SOUND: общая философия



Sound половина должна быть \*\*так же продумана, как генератор\*\*, а не просто:



```text

OSC

FILTER

ENV

```



потому что «так принято».



Цель:



\- 4 sound pages максимум;

\- обычно 2 важных параметра на страницу;

\- каждый scalar sound parameter также может использовать `V/P/C/A`;

\- параметры должны иметь широкий, музыкально полезный диапазон;

\- разные инструменты не обязаны иметь одинаковый sound UI.



\---



\# 17. Текущий baseline Drum SOUND



Это пока хороший рабочий набор, но ещё требует проверки против выбранного DSP backend.



\## Kick



```text

S1 BODY

Pitch

Boom



S2 ATTACK

Snap

Click



S3 SHAPE

Decay

Punch



S4 COLOR

Drive

Tone

```



\## Snare



```text

S1 BODY

Pitch

Body



S2 SNAP

Noise

Snap



S3 SHAPE

Decay

Ring



S4 COLOR

Crisp

Drive

```



\## Hat



```text

S1 SOURCE

Pitch

Metal



S2 SHAPE

Attack

Decay



S3 COLOR

Bright

Grit



S4 SPACE

Pan

Spread

```



\## Perc



```text

S1 BODY

Pitch

Tone



S2 HIT

Ping

Noise



S3 SHAPE

Decay

Ring



S4 SPACE

Pan

Spread

```



\---



\# 18. Bass SOUND baseline



```text

S1 OSC

Shape

Detune



S2 COLOR

FM

Noise



S3 FILTER

Cutoff

Resonance



S4 ENV

Attack

Decay

```



\---



\# 19. Lead SOUND baseline



```text

S1 OSC

Shape

Detune



S2 COLOR

FM

Noise



S3 FILTER

Cutoff

Resonance



S4 ENV

Attack

Release

```



\---



\# 20. Chords SOUND baseline



```text

S1 OSC

Shape

Detune



S2 COLOR

FM

Width



S3 FILTER

Cutoff

Resonance



S4 ENV

Attack

Release

```



\### Статус



Это \*\*не окончательно утверждённая sound architecture\*\*.



Мы специально отметили, что звук надо ещё пройти lane-by-lane и выбрать наиболее интересные восемь параметров с учётом реального backend synth.



\---



\# 21. Важная незакрытая проблема Bass/Lead



После введения общего EVENT A / EVENT B / FORM и Page 4 Repeat появляется архитектурный конфликт.



Если жёстко соблюдать:



```text

4 PATTERN pages

\+

4 SOUND pages

```



то Bass/Lead получают:



```text

P1 EVENT A

P2 EVENT B

P3 FORM

P4 REPEAT

```



и \*\*не остаётся страниц для Pitch / Harmony / note Length / Velocity / Range и т. п.\*\*



Это пока \*\*не решено\*\*.



Другому агенту нельзя молча выкидывать эти функции.



Нужно отдельно решить один из вариантов:



\- уплотнить EVENT A/B/FORM;

\- перенести часть note-generation параметров куда-то ещё;

\- разрешить Bass/Lead больше 8 страниц;

\- переработать page budget.



Это один из главных оставшихся design questions.



\---



\# 22. Hardware: 16 Step buttons



Step buttons больше \*\*не являются step sequencer'ом\*\*.



Они делятся на две смысловые области.



\## Левая часть — lane selectors



Зафиксированы:



```text

Kick

Snare

Hat

Perc

Bass

Lead

Chords

```



Короткое нажатие выбирает lane.



\---



\## Правая часть — AUX modes



Подтверждены как минимум:



```text

MIXER

GLOBAL

```



Остальные AUX buttons пока \*\*не заполняем функциями ради заполнения\*\*.



Оставляем резерв.



\---



\# 23. LED-язык Step/Lane/AUX buttons



Нужно сделать визуально простым, не «ёлкой».



Категории:



```text

Drum lanes        → red family

Non-drum lanes    → yellow family

AUX/special modes → purple family

Locked            → один отдельный lock-color

Muted             → LED off, если lane не выбран

```



\## Current



Текущий lane / mode \*\*всегда мигает\*\*.



Это имеет наивысший приоритет, потому что главная задача LED — быстро понять, где пользователь находится.



Примеры:



```text

Kick normal

→ solid red



Kick current

→ blinking red



Bass normal

→ solid yellow



Bass current

→ blinking yellow



Global current

→ blinking purple



Lead locked

→ solid lock-color



Lead current + locked

→ blinking lock-color



Snare muted, not current

→ off



Bass muted + current

→ blinking yellow

```



Если current одновременно muted, факт mute показывается на OLED.



Если current locked + muted:



```text

→ blinking lock-color

```



Для невыбранного muted+locked текущая предпочтительная логика:



```text

lock-color

```



Mute в конфликте можно уточнить через OLED при выборе.



\---



\# 24. Mute



На Move уже есть физическая Mute-кнопка.



Предлагаемый жест:



```text

MUTE + lane selector

→ toggle mute

```



Mute относится к аудио lane.



\---



\# 25. Lock



Lock вызывается сочетанием \*\*какой-то правой modifier-button + lane selector\*\*.



Конкретная физическая кнопка пока не выбрана.



Lock — не write protection ручек.



Пользователь всё ещё может вручную редактировать locked lane.



Его смысл — защитить lane от автоматизированных state transitions.



Минимально:



\- scene recall/morph не должен менять locked lane;

\- Wander не должен менять locked lane.



Вероятно также lane-level randomization, но это надо явно решить.



Поведение Global Macro относительно Lock пока не зафиксировано.



\---



\# 26. Header OLED: Mute/Lock



В header всегда есть \*\*зарезервированные фиксированные места\*\* под иконки.



Никаких layout shifts.



Пример:



```text

BAS \[M]\[L]  ●●■●●●●●  PITCH

```



Если состояние отсутствует, слот остаётся пустым:



```text

BAS \[ ]\[ ] ...

BAS \[M]\[ ] ...

BAS \[ ]\[L] ...

BAS \[M]\[L] ...

```



Навигация не должна дёргаться.



\---



\# 27. Трёхбуквенные идентификаторы



Рабочий набор:



```text

KCK  Kick

SNR  Snare

HAT  Hat

PRC  Perc



BAS  Bass

LEA  Lead

CHD  Chords



MIX  Mixer

GLB  Global

```



`LEA`, а не `LED`, чтобы не путать с LED.



\---



\# 28. 4 физических Track buttons



Это \*\*не lane selectors\*\*.



Четыре Track-кнопки отданы под пользовательские bookmarks страниц.



Каждый bookmark хранит только:



```text

lane/context

\+

page

```



Пример:



```text

Track 1 → Bass / Filter

Track 2 → Chords / Play

Track 3 → Hat / Event A

Track 4 → Global / page X

```



\## Tap



```text

tap Track N

→ jump to saved page

```



\## Hold



```text

hold Track N

→ overwrite bookmark with current page

```



Никаких:



\- encoder values;

\- scene state;

\- parameter snapshot;

\- sound recall.



Это исключительно \*\*navigation shortcut\*\*.



\---



\# 29. Большое колесо



Основная функция вращения:



```text

rotate

→ previous / next page

```



То есть последовательное листание страниц выбранного lane/AUX context.



\---



\# 30. Wheel-touch momentary mode



Касание большого колеса без нажатия включает \*\*моментальный pad layer\*\*.



Никакого latch-mode.



Пока палец на колесе — pad functions временно меняются.



Отпустил колесо — normal pad mode немедленно возвращается.



\---



\# 31. Pads в normal mode



В обычном состоянии pads показывают \*\*Scene slots\*\*.



То есть performance surface не занят меню.



\---



\# 32. Pads при wheel-touch



Текущая схема:



```text

ROW 1

Page 1–8 direct selection



ROW 2

reserved



ROW 3

reserved



ROW 4

Transition ×4 + Wander ×4

```



Два ряда намеренно оставлены свободными.



Не заполнять speculative функциями.



Они резервируются:



\- если позже появится >8 страниц;

\- если нужны дополнительные performance modes;

\- если появятся действительно полезные функции.



\---



\# 33. Direct Page Select



Первый 8-pad row:



```text

Pad 1 → Page 1

...

Pad 8 → Page 8

```



Работает параллельно с wheel rotation.



То есть:



```text

wheel

→ sequential navigation



touch wheel + page pad

→ direct navigation

```



\---



\# 34. Lane hold / peek



Удержание lane-selection button вызывает похожий временный режим.



\## Hold lane



OLED временно показывает:



\- выбранный удержанием lane;

\- его визуализацию;

\- его page overview.



Но активный рабочий контекст ещё \*\*не меняется окончательно\*\*.



\## Если отпустить lane



```text

→ вернуться ровно к предыдущему lane/page

```



\## Если во время hold нажать page pad



```text

hold LEAD

\+

pad 7



→ commit switch to Lead

→ open Page 7

```



То есть hold — безопасный \*\*peek\*\*, page pad — commit.



\---



\# 35. Transition settings



На wheel-touch bottom row четыре pad'а:



```text

NOW

FAST

MEDIUM

SLOW

```



Они определяют \*\*общую текущую длительность morph/transition\*\*.



Это не четыре разных recall-команды.



Это один setting:



> сколько длится следующий переход текущего состояния к target Scene.



Точные времена ещё не определены.



\---



\# 36. Wander interval



Оставшиеся четыре pad'а bottom row:



```text

FAST

MEDIUM

SLOW

GLACIAL

```



Они определяют:



> через какой интервал Wander выбирает новую Scene-кандидата.



Они \*\*не определяют transition duration\*\*.



Wander использует текущий Transition setting.



\---



\# 37. Transition и Wander полностью независимы



Пример:



```text

Transition = SLOW

Wander = FAST

```



новые target Scene могут появляться быстрее, чем заканчивается morph.



Это специально допустимо.



В результате система может постоянно дрейфовать и никогда буквально не достигать ни одной сохранённой Scene.



Другой вариант:



```text

Transition = FAST

Wander = GLACIAL

```



система быстро приходит в Scene и долго там остаётся.



\---



\# 38. Retargeting morph



Ключевая семантика.



В момент любого trigger:



```text

START  = current actual state right now

TARGET = selected Scene

TIME   = current Transition duration

```



Начинается:



```text

START → TARGET

```



Если до завершения morph приходит новый target:



```text

A --------→ B

&#x20;     X



новый target = C



X --------→ C

```



То есть новый morph начинается \*\*из фактического текущего интерполированного состояния X\*\*.



Не из последней Scene.



Не из старого A.



Не нужно ждать окончания предыдущего morph.



\---



\# 39. Wander algorithm skeleton



```text

wait current Wander interval



choose candidate Scene



snapshot current actual interpolated state



start morph:

current → candidate

using current Transition duration



continue Wander clock independently

```



Если следующий interval истёк посреди morph — просто новый retarget.



\### Пока не решено



\- как Wander выбирает кандидата;

\- полностью random или weighted;

\- избегает ли текущей Scene;

\- должен ли учитывать similarity;

\- как выключается Wander после выбора одной из четырёх скоростей.



Последний пункт особенно нужно решить: кнопки interval определены, но точная on/off gesture ещё не зафиксирована.



\---



\# 40. Continuous Blend / crossfade удалён



В оригинальном PTNSHIFT crossfade был завязан на физическую поверхность, которой в нашей схеме нет.



Поэтому отдельный continuous Blend/crossfade mode \*\*не нужен\*\*.



Его функциональность частично заменяет transition/morph engine.



\---



\# 41. Theme



Theme исторически обсуждался как PTNSHIFT-функция, но в текущем упрощённом control surface \*\*не имеет зафиксированного места и поведения\*\*.



Другой агент не должен автоматически добавлять Theme в MVP.



\---



\# 42. Record



Физическая `Record`:



```text

Record

→ save current entire Working Scene

→ create new immutable Scene in Journal

```



Всегда новая Scene.



\---



\# 43. Capture



Ранее было предложено:



```text

Capture

→ randomize selected lane

```



Эта идея остаётся разумной и не была явно отменена.



Но старая идея:



```text

Capture + touch encoder

→ reroll hidden parameter seed

```



\*\*устарела\*\*, потому что теперь параметр имеет явный `Pattern`.



Если Capture остаётся lane randomizer, нужно ещё определить:



\- какие параметры randomize;

\- затрагивает ли SOUND;

\- затрагивает ли EVENT A/B;

\- учитывает ли Lock;

\- насколько constrained randomization.



\---



\# 44. Browse / Journal → Set



Сценарий копирования:



```text

Browse / Journal

→ выбрать Scene

→ COPY

```



В буфере ссылка на Scene.



Потом:



```text

Set mode

→ +/- выбрать target Set

→ paste через Copy/Paste interaction

```



В Set добавляется \*\*ссылка на целую Scene\*\*.



Никаких отдельных lane references.



Никакой новой копии Scene не создаётся.



\---



\# 45. Set switching



В Set mode:



```text

\+ / -

→ previous / next Set

```



\---



\# 46. Remove Scene from Set



В Set mode:



```text

DEL + Scene pad

→ remove that Scene reference from current Set

```



Исходная Scene в Journal остаётся.



\---



\# 47. Delete Set



Зафиксирована идея:



```text

DEL + нижний Set-selector / нижняя полоса

→ delete current Set

```



Конкретную физическую реализацию «нижней полосы» стоит уточнить в hardware map.



Так как операция крупная, можно позже решить вопрос подтверждения, но это пока не фиксировано.



\---



\# 48. Set — только Scenes



Ещё раз, потому что это принципиально:



```text

Set

≠ pool per lane

```



Нельзя:



```text

Set / Bass pool

Set / Kick pool

```



Правильно:



```text

Set

├ Scene A

├ Scene B

├ Scene C

...

```



Lane — внутренняя часть Scene.



\---



\# 49. Mixer AUX mode



`MIX` — отдельный AUX context.



Mixer хранится \*\*вне Scene\*\*.



То есть Scene recall / Wander / morph \*\*не должны менять mixer levels\*\*.



В Mixer:



```text

Encoder 1 → Kick Level

Encoder 2 → Snare Level

Encoder 3 → Hat Level

Encoder 4 → Perc Level

Encoder 5 → Bass Level

Encoder 6 → Lead Level

Encoder 7 → Chords Level

Encoder 8 → Master

```



Это Project/global state.



\---



\# 50. Global AUX mode



`GLB` — второй подтверждённый AUX context.



Здесь есть две идеи.



\## Global Settings



Зафиксирована \*\*одна страница\*\*:



```text

Tempo

Swing

Root

Scale



Transpose

Bar

Phrase

Seed

```



Elektron-style direct 4×2.



\### Tempo



Master BPM.



\### Swing



Глобальный swing.



\### Root



Глобальная базовая тоника.



\### Scale



Глобальный scale/mode.



\### Transpose



Транспозиция pitched material.



\### Bar



Метрическая основа.



\### Phrase



Глобальная phrase length/reference.



\### Seed



Глобальный deterministic/randomization seed там, где нужен.



Других Global Settings pages пока не нужно.



\---



\# 51. Global Macro level



Отдельная идея внутри Global:



> крутить \*\*уже существующие одинаковые параметры сразу у нескольких lane\*\*.



Никаких новых:



```text

Energy

Magic

Complexity

Excitement

...

```



не вводить.



То есть если Bass, Lead и Chords имеют:



```text

Cutoff

```



Global Cutoff делает временный offset их существующих Cutoff.



Принцип:



```text

effective = storedValue + globalOffset

```



Stored value Scene не меняется.



Вернули Global offset в 0:



```text

→ исходные значения вернулись

```



Если у lane параметра нет — lane просто не реагирует.



Нельзя делать semantic hack типа:



```text

Kick Tone ≈ Cutoff

```



только потому что хочется глобальную ручку.



\---



\# 52. Candidate Global Macro controls



Обсуждались как возможные реально существующие общие параметры:



```text

Length

Variation

Cycle

Amount

Pitch

Range

Velocity

Density



Cutoff

Resonance

Attack

Decay

Release

Drive

FM

Width

```



Но \*\*точный набор Global Macro pages пока не утверждён\*\*.



Особенно после изменений архитектуры V/P/C/A его стоит пересобрать.



\---



\# 53. OLED физика



Экран:



```text

128 × 64 px

```



Зафиксирован \*\*единый вертикальный template для всех страниц\*\*.



Никаких разных высот для V/P/C/A и direct-8 pages.



```text

HEADER          10 px

VISUALIZATION   32 px

PARAMETERS      22 px

────────────────────

TOTAL           64 px

```



\---



\# 54. HEADER



Нормально:



```text

\[LANE] \[M]\[L] \[PAGER] \[PAGE NAME]

```



Пример:



```text

BAS \[M]\[ ] ●●■●●●●● PITCH

```



Требования:



\- fixed geometry;

\- M/L имеют постоянные slots;

\- page pager не двигается;

\- title не прыгает;

\- current page должна быть хорошо видна;

\- при wheel scrolling пользователь должен быстро понимать, через какие разделы проходит.



\---



\# 55. Page pager



Так как меню достаточно большое, нужен постоянный overview.



Пример:



```text

● ● ■ ● ● ● ● ●

```



или эквивалент.



Текущий раздел/страница:



\- более крупно;

\- инверсно;

\- либо иным однозначным способом.



Цель — при быстром wheel scroll сразу видеть смену:



```text

EVENT A

EVENT B

FORM

RATCHET

BODY

ATTACK

SHAPE

COLOR

```



\---



\# 56. Normal Visualization



Центральные 32 px показывают \*\*всю текущую фразу lane целиком\*\*.



Не history.



Не окно вокруг playhead.



А полный forecast результата.



То есть UI должен получать события \*\*из того же generator core\*\*, который собирается их воспроизводить.



Желательная архитектурная функция:



```text

previewPhrase(...)

→ generated future events for complete current phrase

```



\---



\# 57. Почему нужна вся phrase



Чтобы пользователь глазами видел, что меняется, когда он крутит генеративные параметры.



Например Bass/Lead:



```text

mini piano roll всей phrase

```



Drum lane:



```text

x---x-x-----x---x...

```



Chords:



```text

harmonic timeline / voicing / arp visualization

```



Визуализация должна обновляться немедленно после изменения параметра, даже если playback ещё не дошёл до изменённой области.



\---



\# 58. Playhead



В normal view playhead можно показывать поверх full phrase, чтобы видеть текущую позицию.



\---



\# 59. Parameter-edit focus mode



Когда пользователь:



\- касается encoder;

\- либо начинает его вращать,



экран временно меняет две верхние зоны.



\## Header



Вместо обычной навигации показывается \*\*полное название текущего параметра\*\*.



Например:



```text

FILTER CUTOFF

```



или:



```text

RATCHET COUNT

```



\---



\# 60. Focus visualization



Вместо полной phrase central 32 px показывают:



> \*\*ровно один полный Cycle редактируемого параметра\*\*



Плюс текущая позиция playhead \*\*внутри этого цикла\*\*.



Например:



```text

PITCH RANGE



▂ ▆ █ ▃ ▁ ▅ ▇

&#x20;     │

&#x20;     ↑ current phase

```



Это особенно полезно для четырёх ручек.



\### Value



Видно сдвиг центра рисунка.



\### Pattern



Видно форму motif.



\### Cycle



Видно изменение длины одного периода.



\### Amount



Видно уменьшение / увеличение глубины, потенциально инверсию.



\---



\# 61. Возврат после encoder touch



После окончания взаимодействия через небольшой timeout:



```text

→ вернуть normal header

→ вернуть full phrase lane visualization

```



Нижние 22 px при этом \*\*не меняют геометрию вообще\*\*.



\---



\# 62. Parameter area: стандартная modulated-pair page



Тип A.



Два параметра на страницу.



Каждый занимает четыре encoder:



```text

Parameter A:

V P C A



Parameter B:

V P C A

```



8 физических encoders:



```text

1 Value A

2 Pattern A

3 Cycle A

4 Amount A



5 Value B

6 Pattern B

7 Cycle B

8 Amount B

```



Пример:



```text

MOTION             RANGE

42 P13 C7 +28      18 P04 C5 -12

```



Поскольку порядок V/P/C/A всегда одинаков, подписи можно сильно сокращать.



\---



\# 63. Direct-8 page



Тип B.



Для параметров, которым V/P/C/A не подходит.



Elektron-style 4×2 grid:



```text

MODE   RATE   GATE   OCT

ARP    1/16    72     2



SPRD   FLOW   STRM   DIR

64      82     18     UP

```



Физическое положение на экране соответствует физическим encoder.



\---



\# 64. Одинаковая геометрия обоих page types



Это зафиксировано.



И Modulated Pair, и Direct-8 используют:



```text

10 px header

32 px visualization

22 px parameters

```



Никакого resize visualization между страницами.



\---



\# 65. Wheel-touch OLED overlay



При касании wheel экран временно должен помочь с navigation.



Показываются:



\- current lane/context;

\- page map / page names;

\- current Transition setting;

\- current Wander setting.



При отпускании возвращается normal page.



\---



\# 66. Hold-lane OLED behavior



При удержании другого lane button OLED показывает именно \*\*визуализацию удерживаемого lane\*\*, а не просто текстовый popup.



Это настоящий preview.



Нажал page pad → commit.



Отпустил → возврат.



\---



\# 67. Backend / DSP architecture



Ранее была принята общая идея:



\- не зависеть от native Ableton Move synth parameter control;

\- использовать управляемые Schwung instruments / собственные DSP adapters;

\- generation/state/morph/UI принадлежат нашему core;

\- synth backend — заменяемая реализация.



Рабочее направление было:



```text

Drums → dedicated Schwung drum synth / libpo32-like backend

Bass/Lead/Chords → Surge XT-like controllable synth backend

```



Но конкретный backend каждого lane нужно считать \*\*рабочим предположением, не окончательно утверждённым API-контрактом\*\*.



Главное архитектурное требование:



```text

semantic state

&#x20;    ↓

adapter

&#x20;    ↓

DSP backend

```



Не позволять UI напрямую зависеть от всей внутренней параметрической поверхности Surge.



\---



\# 68. Scene state vs DSP



Scene должна хранить \*\*наши semantic parameters\*\*, а не голый backend preset.



То есть:



```text

Scene

→ semantic lane state



adapter

→ backend-specific values

```



Это позволит:



\- менять synth backend;

\- нормально morph'ить;

\- randomize;

\- визуализировать;

\- сохранять совместимые Scenes.



\---



\# 69. Что НЕ должно жить в Scene



Зафиксировано:



\*\*Mixer levels\*\* — не Scene state.



Они global/project level.



С большой вероятностью также Global Settings являются project state, а не Scene, но точную boundary для Global Macro offsets ещё стоит явно определить.



\---



\# 70. Harmonic architecture



Bass/Lead генерируют не обязательно окончательные MIDI notes напрямую.



Предпочтительная модель:



```text

Bass/Lead melodic generator

→ abstract movement / desired pitch

→ harmonic constraint from Chords

→ actual allowed note

→ synth

```



Это позволяет менять Chords и автоматически reharmonize Bass/Lead.



\---



\# 71. Chords без звука



Mute/Level Chords не должен обязательно отключать harmonic context.



Нужно различать:



```text

audio output

vs

harmonic generator/context

```



Чтобы можно было использовать Chords как невидимого harmonic conductor.



\---



\# 72. No per-lane Set objects



Внутри Set не должно появиться:



```text

Bass Pattern

Lead Pattern

Kick Pattern

```



как самостоятельных управляемых сущностей.



Можно внутренне хранить lane states как части Scene, но UX и Set semantics всегда оперируют \*\*целыми Scene\*\*.



\---



\# 73. Normal Scene pad behavior



В normal pad mode пользователь выбирает Scene.



Нажатие Scene pad:



```text

target = selected Scene

start morph using current Transition duration

```



Точная Launch Quantization пока не была окончательно закреплена после упрощения.



Её нужно определить отдельно.



\---



\# 74. Morph type system — НЕ РЕШЕНО



Очень важный technical open question.



Есть параметры:



\- continuous float;

\- bipolar float;

\- integer;

\- Cycle length;

\- Pattern ID;

\- enum;

\- Scale;

\- Oscillator type;

\- Arp Mode;

\- Event generator Cycle/Offset;

\- boolean.



Не все из них можно линейно интерполировать.



Нужно формализовать \*\*type-aware morphing\*\*:



```text

continuous → interpolate

integer → ?

pattern ID → ?

enum → ?

cycle → ?

scale → ?

event structure → ?

```



Это один из ключевых пунктов будущего ТЗ.



\---



\# 75. Pattern ID morph — особенно важный вопрос



После введения явного:



```text

PATTERN

```



надо определить, что происходит при Scene morph:



```text

Pattern 12 → Pattern 47

```



Варианты пока не выбраны:



\- discrete switch at threshold;

\- probabilistic blend;

\- interpolate underlying motif space;

\- nearest-neighbour trajectory.



Не следует выбирать молча.



\---



\# 76. Event-generator morph — тоже open



Например:



```text

Cycle 4 → Cycle 7

Offset 0 → Offset 3

```



Нужно определить музыкально осмысленную промежуточную семантику.



\---



\# 77. Pattern bank / motif space



Явный parameter `Pattern` должен выбирать воспроизводимый motif.



Пока точная генерация Pattern bank не определена.



Желательно, чтобы Pattern не ощущался чистой случайной рулеткой.



Но конкретный algorithm ещё не зафиксирован.



\---



\# 78. Parameter cycle semantics



В touch focus мы явно визуализируем \*\*один цикл параметра\*\*.



Для параметров после event generation логично связывать Cycle с последовательностью relevant events.



Но окончательную единицу Cycle для каждого parameter class нужно формально определить.



Особенно:



\- synth modulation;

\- note parameters;

\- chord parameters;

\- time-continuous params.



\---



\# 79. No unnecessary abstractions



Уже несколько раз отвергнут принцип:



```text

Energy

Complexity

Magic

Excitement

...

```



если такой сущности на самом деле нет в lane.



Предпочтение:



> пользователь крутит реальные существующие музыкальные параметры, пусть они и генеративные.



Global работает поверх реальных параметров, а не создаёт псевдо-музыкальные macros.



\---



\# 80. UX принцип



Интерфейс должен быть:



\- быстрым;

\- пространственно запоминающимся;

\- без глубоких меню;

\- без mode soup;

\- без лишних hold-combinations там, где можно дать прямую кнопку;

\- но не упрощённым до игрушки.



Особенно удачные постоянные идеи:



```text

lane → Step button

page → wheel / direct pad

parameter → encoder

scene → pad

bookmark → Track button

save → Record

randomize lane → possibly Capture

```



\---



\# 81. Navigation principle



Колесо отвечает за обычное исследование menu tree.



Bookmarks отвечают за часто используемые страницы.



Wheel-touch отвечает за быстрый direct jump.



Lane-hold отвечает за peek в другой lane.



То есть у одной задачи — переход между страницами — есть три уровня скорости:



```text

wheel

→ browse



wheel-touch + page pad

→ direct jump



Track bookmark

→ one-button favorite jump

```



\---



\# 82. Визуальный принцип



В обычном состоянии экран отвечает:



> \*\*что сейчас играет lane?\*\*



При encoder interaction:



> \*\*как устроен именно этот параметр?\*\*



При wheel-touch:



> \*\*где я нахожусь и куда могу прыгнуть?\*\*



При lane-hold:



> \*\*что делает другой lane и какие у него страницы?\*\*



Это хорошая контекстная модель, потому что пользователь не выбирает вручную тип экрана.



\---



\# 83. Что сейчас считается удалённым / устаревшим



Другому агенту важно не воскресить старые варианты.



Не актуальны:



\- один общий `Drums` lane;

\- Track 1–4 как lane selectors;

\- Step buttons как page selectors в normal mode;

\- отдельные per-lane pools внутри Set;

\- сохранение отдельного lane pattern как Set-object;

\- continuous touch-strip Blend;

\- скрытый per-parameter motif seed как основной механизм;

\- `Capture + touch → reroll hidden motif`;

\- обязательная единая PLAY page с восемью magic macros;

\- попытка сделать идентичные page sets для всех lane;

\- global macros типа Energy/Complexity как новые сущности.



\---



\# 84. Что пока не определено



Для будущего ТЗ это важно вынести отдельным списком.



1\. \*\*Bass/Lead page-budget problem:\*\* куда помещаются Pitch/Harmony/Velocity/Length modulation при EVENT A/B/FORM/REPEAT + 4 SOUND pages.

2\. Финальные SOUND-параметры всех семи lane после проверки реальных DSP backend.

3\. Точный Schwung synth/backend для каждого lane.

4\. Конкретная physical button для Lock modifier.

5\. Wander on/off gesture.

6\. Wander candidate selection algorithm.

7\. Scene launch quantization.

8\. Type-aware Scene morph для enum/int/Pattern/Event-generator params.

9\. Семантика Pattern bank и способ генерации/хранения motif.

10\. Units/range Cycle для разных parameter types.

11\. Точный набор Global Macro pages.

12\. Вход hardware-button в Browse/Journal vs Set mode.

13\. Максимум Scene на Set / нужен ли banking свыше 32.

14\. Поведение Capture lane randomization.

15\. Насколько Global Macro obeys Lock.

16\. Хранить ли Global Macro offsets в Project, Set или Working Scene.

17\. Delete Set confirmation semantics.

18\. Полный Project cleanup/browser UX.



\---



\# 85. Самое компактное описание архитектуры



Если другому агенту нужно сначала понять проект за минуту:



```text

PROJECT

├ Journal: immutable saved Scenes

├ Sets: references to whole Scenes

├ Global Settings

└ global Mixer/Macro state



WORKING SCENE

├ Kick

├ Snare

├ Hat

├ Perc

├ Bass

├ Lead

└ Chords



LANE GENERATION

├ Event Generator

│   ├ A: 2 × Level/Cycle/Offset

│   └ B: 2 × Level/Cycle/Offset

│

├ Parameter Modulators

│   └ Value / Pattern / Cycle / Amount

│

└ Sound Engine



CHORDS

├ specialized harmony generation

├ voicing

├ arp/strum

├ polysynth

└ publishes harmonic context → Bass/Lead



CONTROL SURFACE

├ Step buttons left → lanes

├ Step buttons right → AUX (Mixer, Global, reserve)

├ Track 1–4 → page bookmarks

├ Wheel → page browse

├ Wheel touch → momentary pad layer

├ Encoders → current page

├ Pads normal → Scenes

├ Record → save new Scene

├ Copy → Scene → Set

├ +/- → Sets

└ Mute/Lock modifiers + lane buttons



WHEEL-TOUCH PADS

├ row 1 → Pages 1–8

├ row 2 → reserved

├ row 3 → reserved

└ row 4

&#x20;   ├ Transition: Now/Fast/Med/Slow

&#x20;   └ Wander: Fast/Med/Slow/Glacial



OLED 128×64

├ Header 10

├ Visualization 32

└ Parameters 22



NORMAL OLED

→ full phrase of current lane



ENCODER TOUCH

→ full parameter name

→ one parameter cycle

→ cycle playhead

```



\---



Если это отдавать другому агенту как начало ТЗ, я бы попросил его \*\*не начинать кодирование сразу\*\*, а сначала вернуть три вещи: формализованную state model, окончательную page map каждого lane и type system для morphing. Именно там сейчас находятся реальные архитектурные неопределённости; всё остальное уже довольно хорошо сложилось.

'''

