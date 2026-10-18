/**
 * Disaster scenario presets. Every scenario is DEMO CONTENT: the places, storm names and
 * numbers are fictional and must be presented as such in the UI. 112 is India's real
 * national emergency number.
 *
 * Each message carries pre-authored translations (en/ta/hi/te) so the demo works with
 * Groq offline. They are labelled "pre-translated (scenario preset)" wherever shown.
 *
 * Network curves are per-receiver keyframes consumed by sampleCurve() in simulator.js.
 */

/**
 * @typedef {object} Localized
 * @property {string} text      full announcement
 * @property {string} summary   ultra-short text-mode version
 * @property {string} action    one-line recommended action
 */

/**
 * @typedef {object} ScenarioMessage
 * @property {string} key
 * @property {string} raw                 what the broadcaster would type
 * @property {'LOW'|'NORMAL'|'HIGH'|'CRITICAL'} priority
 * @property {string} category
 * @property {number} confidence
 * @property {Record<'en'|'ta'|'hi'|'te', Localized>} i18n
 * @property {{ lat:number, lng:number, radiusKm:number, label:string }} [zone]
 * @property {number} atSec               when in the scenario timeline it is sent
 */

const CYCLONE_CRITICAL = {
  key: 'cyclone-landfall',
  raw: 'Cyclone Varuna (demo) will make landfall near Nagapattinam between 2 AM and 4 AM tonight with winds up to 140 km/h and a 3 metre storm surge. Everyone within 5 km of the coast must evacuate now to the cyclone shelters on higher ground. Carry documents, medicines and drinking water. Do not travel on coastal roads. Emergency help: 112.',
  priority: 'CRITICAL',
  category: 'CYCLONE',
  confidence: 0.97,
  atSec: 60,
  zone: { lat: 10.7672, lng: 79.8449, radiusKm: 25, label: 'Nagapattinam coast (demo zone)' },
  i18n: {
    en: {
      text: 'URGENT: Cyclone Varuna will make landfall near Nagapattinam between 2 AM and 4 AM tonight with winds up to 140 km/h and a 3 metre storm surge. Everyone within 5 km of the coast must evacuate now to the cyclone shelters on higher ground. Carry documents, medicines and drinking water. Do not travel on coastal roads. Emergency help: 112.',
      summary: 'CYCLONE: Evacuate coast (5 km) NOW. Landfall 2–4 AM. Call 112.',
      action: 'Evacuate to the nearest cyclone shelter now',
    },
    ta: {
      text: 'அவசரம்: வருணா புயல் இன்று இரவு 2 மணி முதல் 4 மணிக்குள் நாகப்பட்டினம் அருகே கரையைக் கடக்கும். காற்றின் வேகம் மணிக்கு 140 கி.மீ. வரை இருக்கும்; 3 மீட்டர் உயரத்துக்குக் கடல் அலைகள் எழும். கடலோரத்திலிருந்து 5 கி.மீ. தொலைவுக்குள் உள்ள அனைவரும் உடனடியாக உயரமான பகுதியில் உள்ள புயல் பாதுகாப்பு மையங்களுக்குச் செல்லுங்கள். ஆவணங்கள், மருந்துகள், குடிநீர் ஆகியவற்றை எடுத்துச் செல்லுங்கள். கடலோரச் சாலைகளில் பயணம் செய்ய வேண்டாம். அவசர உதவி: 112.',
      summary: 'புயல்: கடலோரம் (5 கி.மீ.) உடனே வெளியேறுங்கள். 2–4 மணிக்கு கரை கடக்கும். 112.',
      action: 'உடனே அருகிலுள்ள புயல் பாதுகாப்பு மையத்திற்குச் செல்லுங்கள்',
    },
    hi: {
      text: 'तत्काल: चक्रवात वरुणा आज रात 2 से 4 बजे के बीच नागपट्टिनम के पास तट से टकराएगा। हवाओं की गति 140 किमी/घंटा तक होगी और 3 मीटर ऊँची तूफ़ानी लहरें उठेंगी। तट से 5 किमी के भीतर रहने वाले सभी लोग अभी ऊँचे स्थान पर बने चक्रवात आश्रयों में पहुँचें। दस्तावेज़, दवाइयाँ और पीने का पानी साथ ले जाएँ। तटीय सड़कों पर यात्रा न करें। आपातकालीन सहायता: 112।',
      summary: 'चक्रवात: तट (5 किमी) अभी खाली करें। 2–4 बजे टकराएगा। 112।',
      action: 'अभी नज़दीकी चक्रवात आश्रय में जाएँ',
    },
    te: {
      text: 'అత్యవసరం: వరుణ తుఫాను ఈ రాత్రి 2 నుండి 4 గంటల మధ్య నాగపట్టినం సమీపంలో తీరాన్ని తాకుతుంది. గాలుల వేగం గంటకు 140 కి.మీ. వరకు ఉంటుంది, 3 మీటర్ల ఎత్తున తుఫాను అలలు ఎగసిపడతాయి. తీరం నుండి 5 కి.మీ. లోపల ఉన్నవారంతా వెంటనే ఎత్తైన ప్రాంతంలోని తుఫాను షెల్టర్లకు చేరుకోండి. పత్రాలు, మందులు, తాగునీరు తీసుకెళ్లండి. తీర రహదారులపై ప్రయాణించవద్దు. అత్యవసర సహాయం: 112.',
      summary: 'తుఫాను: తీరం (5 కి.మీ.) వెంటనే ఖాళీ చేయండి. 2–4 గంటలకు తీరం దాటుతుంది. 112.',
      action: 'వెంటనే సమీపంలోని తుఫాను షెల్టర్‌కు వెళ్లండి',
    },
  },
};

const CYCLONE_WATCH = {
  key: 'cyclone-watch',
  raw: 'Cyclone watch: a depression in the Bay of Bengal is intensifying and may reach the Tamil Nadu coast within 24 hours. Fishermen should return to harbour. Keep phones charged.',
  priority: 'HIGH',
  category: 'CYCLONE',
  confidence: 0.9,
  atSec: 20,
  i18n: {
    en: {
      text: 'Cyclone watch: a depression in the Bay of Bengal is intensifying and may reach the Tamil Nadu coast within 24 hours. Fishermen should return to harbour. Keep phones charged.',
      summary: 'CYCLONE WATCH: Fishermen return to harbour. Charge phones.',
      action: 'Return to harbour and charge phones',
    },
    ta: {
      text: 'புயல் எச்சரிக்கை: வங்கக்கடலில் உருவாகியுள்ள காற்றழுத்தத் தாழ்வு வலுப்பெற்று 24 மணி நேரத்துக்குள் தமிழகக் கடலோரத்தை நெருங்கக்கூடும். மீனவர்கள் உடனடியாகத் துறைமுகத்துக்குத் திரும்ப வேண்டும். தொலைபேசிகளை சார்ஜ் செய்து வைத்துக்கொள்ளுங்கள்.',
      summary: 'புயல் எச்சரிக்கை: மீனவர்கள் துறைமுகம் திரும்புங்கள். போன் சார்ஜ் செய்யுங்கள்.',
      action: 'துறைமுகத்துக்குத் திரும்பி, போன்களை சார்ஜ் செய்யுங்கள்',
    },
    hi: {
      text: 'चक्रवात निगरानी: बंगाल की खाड़ी में बना अवदाब तेज़ हो रहा है और 24 घंटे के भीतर तमिलनाडु तट तक पहुँच सकता है। मछुआरे बंदरगाह लौट आएँ। फ़ोन चार्ज रखें।',
      summary: 'चक्रवात निगरानी: मछुआरे बंदरगाह लौटें। फ़ोन चार्ज रखें।',
      action: 'बंदरगाह लौटें और फ़ोन चार्ज रखें',
    },
    te: {
      text: 'తుఫాను హెచ్చరిక: బంగాళాఖాతంలో ఏర్పడిన అల్పపీడనం బలపడుతోంది, 24 గంటల్లో తమిళనాడు తీరానికి చేరే అవకాశం ఉంది. మత్స్యకారులు వెంటనే నౌకాశ్రయానికి తిరిగి రావాలి. ఫోన్లను ఛార్జ్ చేసి ఉంచండి.',
      summary: 'తుఫాను హెచ్చరిక: మత్స్యకారులు నౌకాశ్రయానికి రండి. ఫోన్ ఛార్జ్ చేయండి.',
      action: 'నౌకాశ్రయానికి తిరిగి వచ్చి ఫోన్లను ఛార్జ్ చేయండి',
    },
  },
};

const FLOOD_ALERT = {
  key: 'flood-danger',
  raw: 'Heavy rain: the Adyar river has crossed the danger level. Residents of low-lying areas near the river should move to upper floors or relief camps now. Avoid underpasses and flooded roads. Emergency help: 112.',
  priority: 'HIGH',
  category: 'FLOOD',
  confidence: 0.93,
  atSec: 45,
  zone: { lat: 13.0067, lng: 80.2206, radiusKm: 6, label: 'Adyar riverbank (demo zone)' },
  i18n: {
    en: {
      text: 'Heavy rain: the Adyar river has crossed the danger level. Residents of low-lying areas near the river should move to upper floors or relief camps now. Avoid underpasses and flooded roads. Emergency help: 112.',
      summary: 'FLOOD: Move to upper floors or relief camps. Avoid underpasses. 112.',
      action: 'Move to higher ground or a relief camp',
    },
    ta: {
      text: 'கனமழை: அடையாறு ஆறு அபாய அளவைத் தாண்டியுள்ளது. ஆற்றை ஒட்டிய தாழ்வான பகுதிகளில் வசிப்பவர்கள் உடனடியாக மேல் தளங்களுக்கோ நிவாரண முகாம்களுக்கோ செல்லுங்கள். சுரங்கப்பாதைகளையும் வெள்ளம் சூழ்ந்த சாலைகளையும் தவிர்க்கவும். அவசர உதவி: 112.',
      summary: 'வெள்ளம்: மேல் தளம் அல்லது நிவாரண முகாமுக்குச் செல்லுங்கள். சுரங்கப்பாதை வேண்டாம். 112.',
      action: 'உயரமான இடம் அல்லது நிவாரண முகாமுக்குச் செல்லுங்கள்',
    },
    hi: {
      text: 'भारी बारिश: अडयार नदी ख़तरे के निशान से ऊपर बह रही है। नदी के पास निचले इलाक़ों के निवासी अभी ऊपरी मंज़िलों या राहत शिविरों में चले जाएँ। अंडरपास और जलमग्न सड़कों से बचें। आपातकालीन सहायता: 112।',
      summary: 'बाढ़: ऊपरी मंज़िल या राहत शिविर में जाएँ। अंडरपास से बचें। 112।',
      action: 'ऊँचे स्थान या राहत शिविर में जाएँ',
    },
    te: {
      text: 'భారీ వర్షం: అడయార్ నది ప్రమాద స్థాయిని దాటింది. నదికి సమీపంలోని లోతట్టు ప్రాంతాల నివాసితులు వెంటనే పై అంతస్తులకు లేదా సహాయ శిబిరాలకు వెళ్లండి. అండర్‌పాస్‌లు, నీట మునిగిన రోడ్లను నివారించండి. అత్యవసర సహాయం: 112.',
      summary: 'వరద: పై అంతస్తు లేదా సహాయ శిబిరానికి వెళ్లండి. అండర్‌పాస్ వద్దు. 112.',
      action: 'ఎత్తైన ప్రదేశం లేదా సహాయ శిబిరానికి వెళ్లండి',
    },
  },
};

const QUAKE_ALERT = {
  key: 'quake-aftershock',
  raw: 'A magnitude 5.1 earthquake has struck. Aftershocks are possible over the next hours. Stay in open areas away from damaged buildings and power lines. Do not re-enter cracked buildings. Emergency help: 112.',
  priority: 'CRITICAL',
  category: 'EARTHQUAKE',
  confidence: 0.95,
  atSec: 30,
  zone: { lat: 11.0168, lng: 76.9558, radiusKm: 15, label: 'Coimbatore district (demo zone)' },
  i18n: {
    en: {
      text: 'A magnitude 5.1 earthquake has struck. Aftershocks are possible over the next hours. Stay in open areas away from damaged buildings and power lines. Do not re-enter cracked buildings. Emergency help: 112.',
      summary: 'EARTHQUAKE M5.1: Stay in the open. Aftershocks possible. Avoid damaged buildings. 112.',
      action: 'Move to an open area and stay away from damaged buildings',
    },
    ta: {
      text: 'ரிக்டர் அளவில் 5.1 அளவிலான நிலநடுக்கம் ஏற்பட்டுள்ளது. அடுத்த சில மணி நேரங்களில் பின்அதிர்வுகள் ஏற்படக்கூடும். சேதமடைந்த கட்டடங்கள், மின்கம்பிகளிலிருந்து விலகி திறந்தவெளியில் இருங்கள். விரிசல் விழுந்த கட்டடங்களுக்குள் மீண்டும் செல்ல வேண்டாம். அவசர உதவி: 112.',
      summary: 'நிலநடுக்கம் 5.1: திறந்தவெளியில் இருங்கள். பின்அதிர்வு வரலாம். சேதமடைந்த கட்டடம் வேண்டாம். 112.',
      action: 'திறந்தவெளிக்குச் சென்று சேதமடைந்த கட்டடங்களிலிருந்து விலகி இருங்கள்',
    },
    hi: {
      text: '5.1 तीव्रता का भूकंप आया है। अगले कुछ घंटों में आफ़्टरशॉक संभव हैं। क्षतिग्रस्त इमारतों और बिजली के तारों से दूर, खुले स्थान पर रहें। दरार वाली इमारतों में दोबारा प्रवेश न करें। आपातकालीन सहायता: 112।',
      summary: 'भूकंप 5.1: खुले में रहें। आफ़्टरशॉक संभव। क्षतिग्रस्त इमारतों से दूर रहें। 112।',
      action: 'खुले स्थान पर जाएँ और क्षतिग्रस्त इमारतों से दूर रहें',
    },
    te: {
      text: '5.1 తీవ్రతతో భూకంపం సంభవించింది. రాబోయే కొన్ని గంటల్లో ప్రకంపనలు వచ్చే అవకాశం ఉంది. దెబ్బతిన్న భవనాలు, విద్యుత్ తీగలకు దూరంగా బహిరంగ ప్రదేశంలో ఉండండి. పగుళ్లు వచ్చిన భవనాల్లోకి మళ్లీ వెళ్లవద్దు. అత్యవసర సహాయం: 112.',
      summary: 'భూకంపం 5.1: బయట ఉండండి. ప్రకంపనలు రావచ్చు. దెబ్బతిన్న భవనాలకు దూరం. 112.',
      action: 'బహిరంగ ప్రదేశానికి వెళ్లి దెబ్బతిన్న భవనాలకు దూరంగా ఉండండి',
    },
  },
};

const TOWER_OUTAGE = {
  key: 'tower-outage',
  raw: 'Mobile tower outage in Ward 7. Use SMS for urgent messages or visit the community hall relief desk. Network expected to be restored by 6 PM.',
  priority: 'NORMAL',
  category: 'OTHER',
  confidence: 0.85,
  atSec: 25,
  i18n: {
    en: {
      text: 'Mobile tower outage in Ward 7. Use SMS for urgent messages or visit the community hall relief desk. Network expected to be restored by 6 PM.',
      summary: 'Ward 7 tower outage. Use SMS or community hall desk. Restore ~6 PM.',
      action: 'Use SMS or visit the community hall relief desk',
    },
    ta: {
      text: 'வார்டு 7-இல் செல்போன் கோபுரம் செயலிழந்துள்ளது. அவசரச் செய்திகளுக்கு எஸ்.எம்.எஸ். பயன்படுத்துங்கள் அல்லது சமுதாயக் கூடத்தில் உள்ள நிவாரண மையத்தை அணுகுங்கள். மாலை 6 மணிக்குள் சேவை சீராகும் என எதிர்பார்க்கப்படுகிறது.',
      summary: 'வார்டு 7 கோபுரம் செயலிழப்பு. எஸ்.எம்.எஸ். அல்லது சமுதாயக் கூடம். மாலை 6 மணிக்குள் சீராகும்.',
      action: 'எஸ்.எம்.எஸ். பயன்படுத்துங்கள் அல்லது சமுதாயக் கூட நிவாரண மையத்துக்குச் செல்லுங்கள்',
    },
    hi: {
      text: 'वार्ड 7 में मोबाइल टावर बंद है। ज़रूरी संदेशों के लिए एसएमएस का उपयोग करें या सामुदायिक भवन के राहत डेस्क पर जाएँ। शाम 6 बजे तक नेटवर्क बहाल होने की उम्मीद है।',
      summary: 'वार्ड 7 टावर बंद। एसएमएस या सामुदायिक भवन डेस्क। शाम 6 बजे तक बहाली।',
      action: 'एसएमएस करें या सामुदायिक भवन के राहत डेस्क पर जाएँ',
    },
    te: {
      text: 'వార్డు 7లో మొబైల్ టవర్ పనిచేయడం లేదు. అత్యవసర సందేశాలకు ఎస్ఎంఎస్ వాడండి లేదా కమ్యూనిటీ హాల్‌లోని సహాయ కేంద్రాన్ని సంప్రదించండి. సాయంత్రం 6 గంటలకు నెట్‌వర్క్ పునరుద్ధరించబడుతుందని అంచనా.',
      summary: 'వార్డు 7 టవర్ అంతరాయం. ఎస్ఎంఎస్ లేదా కమ్యూనిటీ హాల్ డెస్క్. సాయంత్రం 6కు పునరుద్ధరణ.',
      action: 'ఎస్ఎంఎస్ వాడండి లేదా కమ్యూనిటీ హాల్ సహాయ కేంద్రానికి వెళ్లండి',
    },
  },
};

/** Standard receiver cohort used by the demo: the 3-receiver story from spec §4.9. */
const DEMO_RECEIVERS = [
  { id: 'A', name: 'Receiver A — Chennai (fibre)', location: { lat: 13.0827, lng: 80.2707 } },
  { id: 'B', name: 'Receiver B — Madurai (4G)', location: { lat: 9.9252, lng: 78.1198 } },
  { id: 'C', name: 'Receiver C — Nagapattinam (weak 2G)', location: { lat: 10.7672, lng: 79.8449 } },
  // ~0.7 km from C: a healthy neighbour that can relay over the simulated mesh when C is offline.
  { id: 'D', name: 'Receiver D — Nagapattinam (neighbour)', location: { lat: 10.7720, lng: 79.8500 } },
];

/** @typedef {{ t:number, slider?:number, offline?:boolean }} Keyframe */

/**
 * @type {Record<string, { id:string, title:string, tagline:string, emoji:string, durationSec:number,
 *   curves: Record<string, Keyframe[]>, messages: ScenarioMessage[] }>}
 */
export const SCENARIOS = Object.freeze({
  cyclone: {
    id: 'cyclone',
    title: 'Cyclone landfall',
    tagline: 'Coastal towers fail one by one as the storm closes in.',
    emoji: '🌀',
    durationSec: 150,
    curves: {
      A: [{ t: 0, slider: 100 }, { t: 90, slider: 92 }, { t: 150, slider: 70 }],
      B: [{ t: 0, slider: 82 }, { t: 40, slider: 62 }, { t: 90, slider: 35 }, { t: 150, slider: 22 }],
      C: [{ t: 0, slider: 60 }, { t: 30, slider: 38 }, { t: 70, slider: 8 }, { t: 110, slider: 3 }, { t: 130, offline: true }],
      D: [{ t: 0, slider: 72 }, { t: 100, slider: 66 }],
    },
    messages: [CYCLONE_WATCH, CYCLONE_CRITICAL],
  },
  flood: {
    id: 'flood',
    title: 'Urban flood',
    tagline: 'Power cuts and congestion degrade the city network.',
    emoji: '🌊',
    durationSec: 120,
    curves: {
      A: [{ t: 0, slider: 95 }, { t: 60, slider: 70 }, { t: 120, slider: 55 }],
      B: [{ t: 0, slider: 70 }, { t: 50, slider: 40 }, { t: 120, slider: 18 }],
      C: [{ t: 0, slider: 45 }, { t: 40, slider: 20 }, { t: 90, slider: 5 }],
      D: [{ t: 0, slider: 72 }, { t: 100, slider: 66 }],
    },
    messages: [FLOOD_ALERT],
  },
  earthquake: {
    id: 'earthquake',
    title: 'Earthquake aftershock',
    tagline: 'A sudden congestion spike, then partial recovery.',
    emoji: '🏚️',
    durationSec: 120,
    curves: {
      A: [{ t: 0, slider: 100 }, { t: 28, slider: 100 }, { t: 34, slider: 25 }, { t: 90, slider: 60 }, { t: 120, slider: 80 }],
      B: [{ t: 0, slider: 85 }, { t: 28, slider: 85 }, { t: 34, slider: 10 }, { t: 100, slider: 35 }],
      C: [{ t: 0, slider: 55 }, { t: 28, slider: 55 }, { t: 34, offline: true }, { t: 80, slider: 15 }, { t: 120, slider: 25 }],
      D: [{ t: 0, slider: 72 }, { t: 100, slider: 66 }],
    },
    messages: [QUAKE_ALERT],
  },
  tower: {
    id: 'tower',
    title: 'Tower outage',
    tagline: 'A local tower dies; neighbours keep a thin link.',
    emoji: '📡',
    durationSec: 100,
    curves: {
      A: [{ t: 0, slider: 100 }, { t: 100, slider: 100 }],
      B: [{ t: 0, slider: 80 }, { t: 30, slider: 45 }, { t: 100, slider: 30 }],
      C: [{ t: 0, slider: 70 }, { t: 20, slider: 12 }, { t: 40, offline: true }, { t: 100, offline: true }],
      D: [{ t: 0, slider: 72 }, { t: 100, slider: 66 }],
    },
    messages: [TOWER_OUTAGE],
  },
});

export const SCENARIO_IDS = Object.freeze(Object.keys(SCENARIOS));
export { DEMO_RECEIVERS };

/** Every scenario message flattened — used by the seed script. */
export function allScenarioMessages() {
  return SCENARIO_IDS.flatMap((id) => SCENARIOS[id].messages.map((m) => ({ scenarioId: id, ...m })));
}
