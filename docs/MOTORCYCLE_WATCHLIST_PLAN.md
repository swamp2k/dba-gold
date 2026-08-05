# DBA Gold watchlists — arbejdsplan

## Mål

Udbyg DBA Gold fra engangsanalyse og simple gentagne søgninger til en vedvarende watchlist, der kan følge motorcykelkandidater over tid uden at sende hele søgeresultatet til AI ved hver kørsel.

Motorcykelprofilen er første konkrete brugssag, men datamodellen forbliver generisk, så samme funktion senere kan bruges til telefoner, pooludstyr og andre DBA-kategorier.

## Milepæl 1 — watchlist-fundament (denne PR)

- Opret profiler med DBA-søgelink, kriterier, prisgrænse, model og interval.
- Gem en separat baseline pr. profil i Workers KV.
- Registrer nye, tilbagevendte, uændrede, prisfald, prisstigninger og forsvundne annoncer.
- Bevar manuel status: ikke vurderet, interessant, kontaktet og afvist.
- Kør profiler manuelt eller via den eksisterende hourly cron.
- Send kun baseline eller relevante ændringer til Claude.
- Tilføj en mobilvenlig watchlist-side med en færdig motorcykel-skabelon.
- Bevar den eksisterende analyse, historik og recurring-search funktion uændret.

## Milepæl 2 — annonce-detaljer

- Hent detaljesiden kun for nye, tilbagevendte og prisfaldne kandidater.
- Udtræk årgang, kilometer, placering, beskrivelse og strukturerede køretøjsfelter, hvor DBA eksponerer dem.
- Gem et tydeligt kildegrundlag pr. felt, så AI ikke gætter.
- Begræns parallelle detailkald og indfør genbrug/cache.

## Milepæl 3 — bedre rangering

- Tilføj strukturerede profilfelter som ønskede modeller, hårde blokeringer og vægtede præferencer.
- Beregn et deterministisk basisscore før AI-vurderingen.
- Vis én samlet kandidatrangliste på tværs af flere DBA-søgninger.
- Registrer prisudvikling og antal dage online.

## Milepæl 4 — notifikationer

- Send kun besked ved nye relevante kandidater eller væsentlige prisfald.
- Tilføj en rolig digest-mode frem for én besked pr. annonce.
- Understøt eksempelvis mail eller en separat webhook-integration uden at lægge hemmeligheder i koden.

## Afgrænsninger i milepæl 1

- Titel og pris er fortsat de eneste sikre annoncefelter.
- Første kørsel markerer de eksisterende annoncer som baseline/nyfundne.
- Forsvundne annoncer gemmes i 30 dage og ryddes derefter automatisk.
- Maksimalt 250 ændrede annoncer sendes til AI i én watchlist-analyse.
- KV giver ikke transaktionel låsning; løsningen antager én bruger og få samtidige manuelle/planlagte kørsler.
