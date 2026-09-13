// Fixture: the 18 Parool sentences and the phrase splits approved in Milestone 1.
//   node test/splitter.test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Splitter = require("../extension/lib/splitter.js");

const CASES = [
  ["De Fiod heeft beslag gelegd op twee panden van cardiologen van het OLVG-ziekenhuis in Amsterdam."],
  ["Dat melden Investico en Nieuwsuur op basis van onderzoek."],
  ["Donderdag werd duidelijk dat de Fiod,", "de opsporingsdienst van de Belastingdienst,", "acht woningen en bedrijfspanden van cardiologen in Gelderland en Noord-Holland heeft doorzocht."],
  ["De medisch specialisten worden ervan verdacht voor eigen gewin deals te hebben gesloten", "met leveranciers van medische hulpmiddelen."],
  ["Uit onderzoek van Nieuwsuur en Investico blijkt vrijdag", "dat de Fiod op zeker zes panden beslag heeft gelegd."],
  ["Twee panden staan op naam van cardiologen van het OLVG in Amsterdam."],
  ["Volgens Nieuwsuur gaat het om ervaren cardiologen met een lange staat van dienst."],
  ["Twee van hen zouden een belangrijke rol hebben gespeeld bij het uitvoeren van medisch onderzoek", "dat werd betaald door leveranciers van medische hulpmiddelen."],
  ["Het OLVG laat weten nog niet inhoudelijk op het onderzoek van de Fiod te kunnen reageren."],
  ["‘Zodra er meer duidelijkheid is over eventuele maatregelen of gevolgen voor de patiëntenzorg,", "zullen we daar meer informatie over plaatsen,’", "schrijft het ziekenhuis."],
  ["Jarenlang betalingen ontvangen"],
  ["De Fiod zegt te vermoeden", "dat cardiologen jarenlang betalingen hebben ontvangen van leveranciers van medische hulpmiddelen."],
  ["In ruil daarvoor zouden ze expres de producten van die leveranciers hebben voorgeschreven."],
  ["De Fiod stelt", "dat corruptie en ongewenste financiële relaties tussen medisch specialisten en de medische industrie", "het vertrouwen van patiënten in de zorg kunnen schaden."],
  ["Eerder waren er al strafrechtelijke onderzoeken naar vermoedens van omkoping", "in de medische sector in 2018 en 2022."],
  ["Later doken de media ook in de handel en wandel van de medische sector."],
  ["De Fiod zegt nog steeds signalen te krijgen van geldstromen", "die kunnen wijzen op belangenverstrengeling,", "ongewenst gunstbetoon of zelfs omkoping."],
  ["Daarom gaat de dienst hierover ook in gesprek met ziekenhuizen en medisch specialisten,", "los van de strafrechtelijke onderzoeken."],
];

let pass = 0;
for (const [n, expected] of CASES.entries()) {
  const got = Splitter.split(expected.join(" "));
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) pass++;
  else { console.log(`\n#${n + 1} MISMATCH`); console.log("  expected:", expected); console.log("  got:     ", got); }
}
console.log(`\n${pass} / ${CASES.length} sentences split as approved`);
process.exit(pass === CASES.length ? 0 : 1);
