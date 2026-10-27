# Lägga till en ny DYMO-rulle

En steg-för-steg-guide för en rulle som tjänsten inte känner till än. Engelska: [new-roll.md](new-roll.md).

## Är rullen redan känd?

De inbyggda rullarna är kalibrerade och skriver ut direkt när de sitter i:

| Artikel | Etikett |
| --- | --- |
| S0722540 | 57 × 32 mm |
| S0722550 | 19 × 51 mm (med vik-del; skriver på den 19 mm breda delen) |
| S0722520 | 25 × 54 mm |
| S0722430 | 54 × 101 mm |
| 2166659 | 102 × 210 mm fraktetikett |

En rulle som har lagts till tidigare finns i tabellen Rolls på admin-sidan. Sätt i rullen, klicka **Read loaded roll** och sedan **Use the detected format**. Mer behövs inte.

## En ny sorts rulle

Innan du börjar: stäng DYMO Connect på alla datorer som delar skrivaren. Dess bakgrundstjänst håller skrivaren upptagen, och då kan en provetikett stanna halvvägs.

### 1. Läs av rullen och lägg till den

1. Sätt i rullen i skrivaren.
2. Öppna admin-sidan. Under **Printer** klickar du **Read loaded roll**.
3. Klicka **Add this roll**. Formuläret fylls i med artikelnummer, bredd och längd från rullens chip.
4. Kontrollera måtten med linjal. Mät själva etiketten, inte bakpappret. Chipet ger hela etiketten. På en etikett med vik-del anger du bara den del som du skriver på.
5. Klicka **Add roll**. Rullen får status *testing*. Den skriver bara ut sin provetikett tills du godkänner den.

### 2. Skriv ut provetiketten

1. I tabellen Rolls klickar du **Test print** på den nya rullen.
2. Klicka **Use as the loaded roll of this printer**.
3. Klicka **Prepare test label** och sedan **Print the test label**.

Provetiketten har en ram av fyra raka linjer. Varje linje ligger 5 mm innanför kanten (mindre på mycket små rullar; sidan visar avståndet).

### 3. Mät och godkänn

1. Mät med skjutmått på varje sida, från etikettens kant till linjens yttre kant. Läs sidorna så som förhandsvisningen visar etiketten. På en etikett med vik-del mäter du från vik-linjen, inte från vik-delens yttre kant.
2. Fyll i de fyra måtten: upptill (top), höger (right), nedtill (bottom) och vänster (left).
3. Klicka **Approve the test print**. Tjänsten flyttar bilden på plats och sparar de kanter som inte skrivs ut (minst 1 mm på varje sida).
4. Om sidan säger att måtten inte kan stämma, mät igen. En provetikett kan bara godkännas en gång. Skriv ut en ny om du behöver börja om.

### 4. Kontrollera

1. Klicka **Test again** och skriv ut en provetikett till.
2. Alla fyra mått bör nu vara ungefär 5 mm. Upptill och nedtill kan bli några tiondelar mer, eftersom en stansad etikett är lite längre än sin sida.
3. Om en sida skiljer mer än ungefär 0,3 mm, fyll i de nya måtten och godkänn igen. Varje varv gör det mer exakt.

### 5. Använd rullen i Label Studio

En mall är gjord för en rulle, eller för alla rullar.

- För en ny mall: välj den nya rullen under **Label format**.
- För en befintlig mall: duplicera den och välj den nya rullen, eller kryssa i **Any roll** så att den följer storleken på varje rulle.
- Förhandsgranska och publicera sedan mallen. Bara publicerade mallar skrivs ut för vanliga nycklar.

## Mäta om en rulle

Klicka **Test again** på rullen när som helst, till exempel efter byte av skrivare. Innan du godkänner visar sidan vilka mallar som skulle hamna i de nya kanterna.
