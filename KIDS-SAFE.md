# Kids-safe AI Playground: filtry treści

Ten fork [intel/AI-Playground](https://github.com/intel/AI-Playground) dodaje filtry nieodpowiednich treści. Każdy filtr działa według zasady „w razie wątpliwości blokuj”: jeśli sprawdzenie nie może się odbyć, prośba zostaje zablokowana.

## Co jest filtrowane

| Miejsce | Sprawdzenie |
| --- | --- |
| Wiadomość wpisana przez użytkownika na czacie | Lista słów (polskich i angielskich), a potem ocena promptu przez Qwen3Guard-Gen-4B, zanim uruchomi się jakikolwiek model |
| Odpowiedź czatu | Pokazywana kawałkami. Każdy kawałek ocenia Qwen3Guard (razem z pytaniem i końcówką już pokazanego tekstu), zanim się wyświetli. Zablokowany kawałek nigdy się nie pojawia: odpowiedź się urywa i dochodzi komunikat o blokadzie. Tekst rozumowania modelu („thinking”) nigdy się nie wyświetla |
| Wywołanie narzędzia w czacie (MCP, przeglądarka, narzędzia multimedialne) | Tekst wejścia narzędzia (np. zapytanie wyszukiwarki) ocenia Qwen3Guard, zanim karta narzędzia w ogóle się pojawi; zablokowane wywołanie nie wyświetla się wcale, odpowiedź się urywa i dochodzi komunikat o blokadzie. Tekst wyniku ocenia tak samo jak odpowiedź, zanim się wyświetli. Zablokowany wynik nigdy się nie pojawia: na karcie narzędzia zostaje komunikat „Wynik tego narzędzia został ukryty ze względów bezpieczeństwa”, odpowiedź się urywa i dochodzi komunikat o blokadzie. Stop w trakcie sprawdzania wyniku zostawia na karcie „Sprawdzanie wyniku tego narzędzia zostało przerwane” |
| Prompt obrazu (panel obrazów i narzędzie obrazów w czacie) | To samo sprawdzenie promptu, zanim ruszy ComfyUI |
| Wygenerowany obraz | Węzeł `SafetyChecker` (vit-base-nsfw-detector) na każdym obrazie z serii, z progiem zablokowanym na 0,4 (czułość 0,6). Obejmuje też warianty OpenVINO, Colorize, Change Face i Upscale |
| Nienaruszalność filtra obrazów | Przed każdym generowaniem obrazu aplikacja sprawdza workflow, który ma wysłać: każdy węzeł, który zapisuje lub podgląda obrazy (`SaveImage`, każdy inny węzeł `*Save*` przyjmujący obrazy, nawet jeśli przekazuje je dalej, a w presetach obrazów także `PreviewImage` i każdy inny węzeł kończący graf, do którego wchodzą obrazy), musi dostawać je prosto z węzła `SafetyChecker` z progiem 0,4 lub niższym, inaczej generowanie zostaje odrzucone, zanim ComfyUI zapisze cokolwiek na dysk. Obraz z każdego innego węzła nigdy się nie wyświetla (animacje są dozwolone tylko w presetach wideo, których nic nie filtruje). Pliki węzła `SafetyChecker` są porównywane z kopią wbudowaną w aplikację i przywracane (z ponownym uruchomieniem ComfyUI), jeśli ktoś je zmienił |
| Podgląd na żywo | Nigdy się nie wyświetla, bo to niefiltrowane klatki pośrednie |
| Tryb agenta (Agent, Game Agent, Quick Coder) | Wyłączony, bo odpowiedzi agenta nie przechodzą przez filtr czatu |

Kontrola nienaruszalności odrzuca dwa rodzaje presetów, które zapisują obrazy bez węzła `SafetyChecker` przed zapisem: partnerski preset Acer VisionArt (zapisuje obraz własnym węzłem Acera) i presety „Dummy Image” oraz „Dummy Edit”, dostępne tylko w trybie deweloperskim.

Na zablokowaną prośbę aplikacja odpowiada: „Nie mogę w tym pomóc. Zapytaj o coś innego. / I can't help with that. Try asking about something else.” Blokują oba werdykty modelu: „Unsafe” i „Controversial”. Zatrzymanie odpowiedzi przyciskiem Stop w trakcie sprawdzania nie jest blokadą: odpowiedź po prostu się kończy, bez komunikatu.

## Wymagania

- Musi być zainstalowany backend Llama.cpp. Model bezpieczeństwa działa na osobnym llama-serverze dostępnym tylko lokalnie (loopback) i nigdy nie używa parametrów uruchomienia ustawionych przez użytkownika.
- Przy pierwszym użyciu aplikacja prosi w jednym oknie o pobranie obu modeli bezpieczeństwa: `mradermacher/Qwen3Guard-Gen-4B-GGUF` (Q4_K_M, około 2,7 GB) i `QuantFactory/Qwen3Guard-Gen-0.6B-GGUF` (Q8_0, około 0,8 GB). Dzięki temu model zapasowy nigdy nie pobiera się w trakcie pracy. Dopóki nie pobierze się przynajmniej jeden z nich, czat i generowanie obrazów są zablokowane.
- Pomiary na zintegrowanej grafice Intel Core Ultra 5 135U z modelem czatu Qwen3.5-4B: sprawdzenie promptu trwa około 2 s. Pierwsza część odpowiedzi pojawia się po około 20 s (bez filtra po 3–4 s), a odpowiedź o długości 1650 znaków jest w całości widoczna po około 77 s (bez filtra po około 55 s). Ponieważ model bezpieczeństwa dzieli kartę graficzną z modelem czatu, generowanie zwalnia o około 25%. Na procesorze model bezpieczeństwa działał na tym laptopie jeszcze wolniej.
- Presety obrazów pobierają `AdamCodd/vit-base-nsfw-detector`, tak jak w oryginalnej aplikacji.

## Gdzie działa model bezpieczeństwa

Aplikacja wybiera miejsce dla modelu bezpieczeństwa na podstawie sprzętu i próbuje kolejnych możliwości po kolei. Bierze pierwszą, która mieści się w wolnej pamięci (z zapasem). Ostatnia możliwość jest używana nawet wtedy, gdy się nie mieści. W pamięci 4B zajmuje około 3,6 GiB, a 0.6B około 1,4 GiB.

| Sprzęt | Kolejność prób | W trakcie generowania obrazów |
| --- | --- | --- |
| Bez karty graficznej | 4B na procesorze, 0.6B na procesorze | Działa dalej |
| Zintegrowana grafika (pamięć współdzielona) | 4B na grafice, 4B na procesorze, 0.6B na grafice, 0.6B na procesorze | Zatrzymany, żeby model obrazów dostał pamięć |
| Osobna karta, 8 GiB lub mniej (albo nieznana ilość) | 4B na procesorze, 0.6B na karcie, 0.6B na procesorze | Na procesorze działa dalej, 0.6B na karcie jest zatrzymywany |
| Osobna karta, ponad 8 GiB | 4B na karcie, 4B na procesorze, 0.6B na karcie, 0.6B na procesorze | Na procesorze działa dalej, na karcie jest zatrzymywany |

- 0.6B służy tylko jako model zapasowy. W projektowym zestawie 50 polskich promptów przepuścił 8 z 30 szkodliwych i zablokował 4 z 20 niewinnych, a model 4B (Q4_K_M) przepuścił 4 i zablokował 1 (bez uwzględnienia listy słów). Żeby go wyłączyć, ustaw `KIDS_GUARD_ALLOW_SMALL_FALLBACK = false` w pliku `WebUI/electron/safety/kidsGuard.ts`. Model 0.6B nie będzie wtedy ani brany pod uwagę, ani pobierany.
- Brakujące albo nieznane dane o pamięci liczą się jako „nie mieści się”. Jeśli żadna możliwość nie da się uruchomić, każde sprawdzenie jest blokowane, tak jak wcześniej.
- Na procesorze model używa rdzeni wydajnościowych i zwykłych rdzeni energooszczędnych (bez rdzeni E o najniższym poborze mocy): od 4 do 8 wątków przy przetwarzaniu promptu i do 4 przy generowaniu. Bez danych o rdzeniach bierze połowę procesorów logicznych (od 4 do 8). Na karcie graficznej używa 2 wątków.
- Prompty obrazów są sprawdzane, zanim karta graficzna przejdzie do generowania obrazów, więc model bezpieczeństwa, który musi się zatrzymać, ma już pracę za sobą. Prompty czatu są sprawdzane, gdy model czatu jest gotowy.

## Kod

- `WebUI/electron/safety/kidsGuard.ts`: klient modelu bezpieczeństwa, lista słów i wstrzymywanie odpowiedzi.
- `WebUI/electron/safety/guardPlacement.ts`, `WebUI/electron/safety/guardFacts.ts`, `WebUI/electron/safety/cpuTopology.ts`: zasady wyboru miejsca, dane o sprzęcie, z których korzystają, i liczba wątków procesora.
- `WebUI/electron/adapters/backends/llamaCppBackendService.ts`: `ensureGuardServer` (pomija parametry uruchomienia ustawione przez użytkownika).
- `WebUI/electron/chat/turnEngine.ts` (prompty i odpowiedzi czatu) oraz `WebUI/electron/kernel/orchestrator.ts` (prompty obrazów): miejsca, w których sprawdzany jest tekst.
- `comfyui-deps/custom_nodes/SafetyChecker/nodes.py` i presety w `modes/base/`: filtr wygenerowanych obrazów.
- `WebUI/electron/safety/imageFilter.ts` i `WebUI/electron/artifact/runner.ts`: kontrola nienaruszalności filtra obrazów.

## Ograniczenia

Żaden filtr nie jest doskonały. W zestawie 50 polskich promptów model 4B razem z listą słów przepuścił 0 z 30 szkodliwych i zablokował 1 z 20 niewinnych (rodzina w strojach kąpielowych na basenie). Zestaw jest mały, więc te liczby to tylko wskazówka. Najsłabszy punkt to krótki polski slang i właśnie dla niego istnieje lista słów.

Próg 0,4 dla obrazów wybrano na podstawie testu na 136 obrazach (bez obrazów jednoznacznie dla dorosłych). Zablokował wszystkie 11 obrazów ze strojami kąpielowymi, bielizną i leżącymi nagimi postaciami, ale też mniej więcej co piąty niewinny obraz wygenerowany z niewinnych promptów testowych (model SD1.5 często rysuje „dziewczynkę”, „syrenę” czy „baletnicę” jako wystylizowane dorosłe kobiety) i 5 z 64 niewinnych zdjęć. Zablokowany obraz wraca czarny.

Presety wideo i zamiana tekstu na mowę nie są filtrowane.

Używaj aplikacji razem z osobnym kontem użytkownika bez uprawnień administratora i z kontrolą rodzicielską systemu. Użytkownik z uprawnieniami administratora może zmienić samą aplikację. Presety obrazów i pliki węzłów ComfyUI są kopiowane do folderu, w którym każdy użytkownik może zapisywać. Zmiany, które usuwają albo osłabiają filtr obrazów, wyłapuje opisana wyżej kontrola nienaruszalności, ale ktoś, kto umie pisać w Pythonie, nadal mógłby zmienić w tym folderze samo ComfyUI albo model wykrywający. Filtr tekstu i kontrola nienaruszalności są częścią plików programu, więc przy instalacji dla wszystkich użytkowników pozostają chronione.

## Instalacja na Windowsie

Jak zbudować instalator, zainstalować aplikację dla użytkownika i przejść listę kontrolną, opisuje [README.md](README.md).
