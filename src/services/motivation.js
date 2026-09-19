import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import { loadState, updateState } from '../store.js';
import { generateText } from './claude.js';
import { uLatinicu } from './pismo.js';

/**
 * Jutarnja motivaciona poruka — generiše je OpenAI.
 *
 * Ranije je ovo pisao isti model kao i ostatak bota, sa identičnim promptom
 * svakog jutra i bez ikakvog pamćenja. Rezultat: poruke se vrte u krug, jer
 * model bez konteksta uvek sklizne u istih par formulacija.
 *
 * Ovde se protiv ponavljanja radi troje:
 *   1. drugi model (OpenAI) — drugačiji "glas" od ostatka bota,
 *   2. poslednjih N poruka ide u prompt kao spisak onoga što se NE sme ponoviti,
 *   3. ugao se rotira po danu, pa ni tema nije ista dva jutra zaredom.
 *
 * Ako OpenAI nije podešen ili pukne, poruku piše Claude — jutro ne sme da
 * ostane bez pozdrava zbog jednog API-ja.
 */

const STANJE = 'motivacije';

// Rotira se po danu da se ne vrti ista tema. Namerno konkretni i različiti —
// "budi motivišući" daje prosek, a prosek je uvek ista rečenica.
const UGLOVI = [
  'jedna konkretna stvar koju vredi završiti danas, pre svega ostalog',
  'disciplina radi i onda kad volja ne radi',
  'mala jutarnja pobeda koja vuče ostatak dana',
  'ono što je juče ostalo nedovršeno danas je prvo na redu',
  'tempo je važniji od naleta — danas samo nastavi niz',
  'telo prvo, glava posle: pokret ujutru menja ceo dan',
  'manje planiranja, više prvog koraka',
  'fokus: isključi ono što ti danas krade pažnju',
  'dosadni dani su ti koji prave razliku, ne spektakularni',
  'uradi danas verziju koja je dovoljno dobra, ne savršena',
  'seti se zašto si počeo — konkretno, ne uopšteno',
  'strpljenje: rezultat kasni za radom nekoliko nedelja',
];

/** Redni broj dana u godini — stabilna rotacija bez čuvanja brojača. */
function danUGodini(datum = new Date()) {
  const pocetak = Date.UTC(datum.getUTCFullYear(), 0, 1);
  const danas = Date.UTC(datum.getUTCFullYear(), datum.getUTCMonth(), datum.getUTCDate());
  return Math.floor((danas - pocetak) / 86_400_000);
}

function ugaoZaDanas() {
  return UGLOVI[danUGodini() % UGLOVI.length];
}

/** Poslednje poslate poruke — ulaze u prompt kao "ovo ne ponavljaj". */
function prethodne() {
  const sve = loadState(STANJE, []);
  return Array.isArray(sve) ? sve : [];
}

function zapamti(poruka) {
  return updateState(
    STANJE,
    (trenutno) => {
      const sve = Array.isArray(trenutno) ? trenutno : [];
      return [...sve, poruka].slice(-config.motivacija.pamti);
    },
    [],
  );
}

function uputstvo({ prognoza, izbegavaj }) {
  const delovi = [
    'Napiši kratku jutarnju motivacionu poruku na srpskom, LATINICOM.',
    'Maksimalno 3 rečenice. Bez Markdown formatiranja, bez naslova, bez navodnika oko poruke.',
    'Ton: energičan i direktan, kao dobar prijatelj — ne kao trener sa seminara.',
    'Zabranjeni klišei: "grabi dan", "ti to možeš", "nebo je granica", "novi dan, nova prilika".',
    `Ugao za danas: ${ugaoZaDanas()}.`,
  ];

  if (prognoza) {
    delovi.push(
      `Prognoza za danas: ${prognoza}`,
      'Prirodno je uklopi u jednu rečenicu (npr. da obuče nešto lakše ili ponese kišobran). ' +
        'Koristi isključivo ove podatke o vremenu — ništa ne izmišljaj.',
    );
  } else {
    delovi.push('Prognoza nije dostupna — ne pominji vreme.');
  }

  if (izbegavaj.length) {
    delovi.push(
      'Poruke poslate prethodnih dana (NE ponavljaj ih — ni formulaciju, ni sliku, ni poentu):',
      izbegavaj.map((p, i) => `${i + 1}. ${p}`).join('\n'),
    );
  }

  return delovi.join('\n\n');
}

/** Skida navodnike koje modeli vole da stave oko cele poruke. */
function ocisti(text) {
  return uLatinicu(text.trim().replace(/^["'„“]|["'”“]$/g, '').trim());
}

async function prekoOpenAI(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.motivacija.openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.motivacija.model,
      messages: [
        {
          role: 'system',
          content:
            'Ti pišeš jutarnje poruke jednoj osobi koja se trudi da bude dosledna — ' +
            'teretana, rad, navike. Pišeš srpskim jezikom i isključivo latinicom. ' +
            'Kratko, konkretno, bez patetike i bez motivacionih fraza sa postera.',
        },
        { role: 'user', content: prompt },
      ],
      // Visoka temperatura + kazne za ponavljanje: cilj je da se dve poruke
      // nikad ne poklope, čak i kad je ugao isti.
      temperature: 1,
      presence_penalty: 0.6,
      frequency_penalty: 0.5,
      max_tokens: 250,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
  }

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI je vratio prazan odgovor.');
  return text;
}

/**
 * Vrati motivacionu poruku za danas i zapamti je da se ne ponovi.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.prognoza] gotov red sa prognozom, ili null
 * @returns {Promise<string>}
 */
export async function motivacionaPoruka({ prognoza = null } = {}) {
  const izbegavaj = prethodne();
  const prompt = uputstvo({ prognoza, izbegavaj });

  let poruka;
  if (featureEnabled.motivacija) {
    try {
      poruka = ocisti(await prekoOpenAI(prompt));
      logger.info(`Motivacija: OpenAI (${config.motivacija.model}), pamti ${izbegavaj.length} prethodnih.`);
    } catch (err) {
      logger.error('OpenAI motivacija nije uspela, prelazim na Claude:', err.message);
    }
  }

  if (!poruka) {
    poruka = ocisti(await generateText(prompt));
    logger.info('Motivacija: Claude (rezervni put).');
  }

  // Pamćenje je pomoćno — ako upis padne, poruka svejedno ide korisniku.
  await zapamti(poruka).catch((err) =>
    logger.error('Ne mogu da zapamtim motivacionu poruku:', err.message),
  );

  return poruka;
}
