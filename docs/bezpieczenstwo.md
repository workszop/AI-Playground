# Bezpieczeństwo treści w Kids-safe AI Playground

Patch dodaje do aplikacji Intel AI Playground filtry tekstu i obrazów oraz wyłącza funkcje, które by je omijały. Jeśli sprawdzenie nie może się odbyć, bo model bezpieczeństwa nie wystartował, zwrócił błąd albo jeszcze się nie pobrał, prośba jest blokowana.

## Czat

- Wiadomość użytkownika sprawdza najpierw lista polskich i angielskich słów (wulgaryzmy, slang seksualny, narkotyki, np. „dopalacze”), a potem model Qwen3Guard-Gen-4B. Model czatu dostaje prompt dopiero wtedy, gdy oba sprawdzenia przejdą.
- Odpowiedź pojawia się na ekranie kawałkami. Qwen3Guard ocenia każdy kawałek razem z pytaniem i końcówką tego, co już widać. Jeśli zablokuje kawałek, odpowiedź urywa się przed nim i pojawia się komunikat o blokadzie.
- Blokują oba werdykty modelu: „Unsafe” i „Controversial”.
- Tekst rozumowania modelu („thinking”) nie przechodzi przez filtr, więc nigdy się nie wyświetla.
- Kiedy generowanie przerwie błąd, użytkownik widzi stały komunikat. Surowy tekst błędu mógłby zawierać niesprawdzony fragment odpowiedzi, dlatego nie trafia na ekran.

## Narzędzia w czacie (MCP, przeglądarka, narzędzia multimedialne)

- Wejście narzędzia, np. zapytanie do wyszukiwarki, jest sprawdzane, zanim pojawi się karta narzędzia. Zablokowanego wywołania użytkownik nie zobaczy.
- Wynik narzędzia przechodzi to samo sprawdzenie co odpowiedź. Zamiast zablokowanego wyniku karta pokazuje informację, że ukryto go ze względów bezpieczeństwa.

## Generowanie obrazów

- Prompt obrazu, wpisany w panelu albo wysłany przez narzędzie w czacie, jest sprawdzany tak samo jak wiadomość na czacie, zanim ruszy ComfyUI.
- Każdy wygenerowany obraz ocenia klasyfikator NSFW (vit-base-nsfw-detector). Obraz z wynikiem powyżej 0,4 wraca czarny.
- W oryginalnej aplikacji filtr był domyślnie włączony z progiem 0,5, ale użytkownik mógł go zmienić suwakiem, a ustawiony na 0 przestawał cokolwiek blokować. Tutaj działa zawsze, z progiem zablokowanym na 0,4. Ustawienia nie ma w interfejsie, a stare zapisane wartości są ignorowane.
- Oryginalny węzeł oceniał tylko pierwszy obraz z serii. Teraz ocenia każdy, a gdy choć jeden przekroczy próg, czarna wraca cała seria.
- Filtr dostały też presety, które go nie miały: warianty OpenVINO, Colorize, Change Face i Upscale.
- Podgląd na żywo jest wyłączony, bo pokazywał niefiltrowane klatki pośrednie.

## Ochrona przed obejściem filtra obrazów

Presety i pliki węzłów ComfyUI leżą w folderze, do którego może pisać każdy użytkownik komputera, więc dałoby się z nich usunąć filtr. Dlatego przed każdym generowaniem aplikacja sprawdza workflow, który wysyła do ComfyUI:

- każdy węzeł, który zapisuje albo pokazuje obrazy, musi je dostawać prosto z węzła `SafetyChecker` z progiem 0,4 lub niższym; jeśli nie dostaje, generowanie zostaje odrzucone, zanim cokolwiek trafi na dysk;
- obrazy z innych węzłów się nie wyświetlają;
- pliki węzła `SafetyChecker` są porównywane z kopią wbudowaną w aplikację i przywracane, jeśli ktoś je zmienił.

Ta kontrola odrzuca preset Acer VisionArt, który zapisuje obrazy własnym węzłem z pominięciem filtra. Testowe presety „Dummy Image” i „Dummy Edit” z trybu deweloperskiego zapisują obrazy przez `SafetyChecker`, więc ją przechodzą.

## Wyłączone funkcje

- Tryb agenta (Agent, Game Agent, Quick Coder): jego odpowiedzi nie przechodzą przez filtr czatu.
- Home Agent, czyli rozmowa z aplikacją przez Telegram, Slack i stronę w sieci lokalnej, został usunięty w całości. Do modeli można się dostać tylko przez okno aplikacji, w którym działają filtry.

## Model bezpieczeństwa

- Qwen3Guard-Gen-4B (Q4_K_M) ocenia polski tekst bezpośrednio, bez tłumaczenia. Mniejszy Qwen3Guard-Gen-0.6B służy za zapas, gdy 4B nie mieści się w pamięci albo nie da się go uruchomić.
- Model działa na osobnym llama-serverze, dostępnym tylko lokalnie, i nie korzysta z parametrów uruchomienia ustawionych przez użytkownika.
- Aplikacja sama wybiera, czy uruchomić go na karcie graficznej, czy na procesorze. Decyduje sprzęt i ilość wolnej pamięci.

## Wyniki testów i ograniczenia

- W projektowym zestawie 50 polskich promptów model 4B razem z listą słów przepuścił 0 z 30 szkodliwych i zablokował 1 z 20 niewinnych. Zestaw jest mały, więc te liczby to tylko wskazówka.
- Próg 0,4 dla obrazów zablokował w teście wszystkie 11 obrazów ze strojami kąpielowymi, bielizną i nagimi postaciami. Zablokował też mniej więcej co piąty niewinny obraz z modelu SD1.5 i 5 z 64 niewinnych zdjęć.
- Presety wideo i zamiana tekstu na mowę nie są filtrowane.
- Filtr spowalnia czat. Na zintegrowanej grafice Intel Core Ultra 5 135U pierwsza część odpowiedzi pojawia się po około 20 s, a bez filtra po 3–4 s.
- Aplikacji używaj na osobnym koncie bez uprawnień administratora i z włączoną kontrolą rodzicielską systemu. Administrator może zmienić samą aplikację. Ktoś, kto zna Pythona, mógłby też zmienić samo ComfyUI albo model wykrywający w folderze, do którego każdy ma prawo zapisu.
