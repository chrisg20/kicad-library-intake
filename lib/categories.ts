export const libraryCategories = [
  { id: "CG_Resistors", label: "Resistors" },
  { id: "CG_Potentiometers", label: "Potentiometers" },
  { id: "CG_Capacitors", label: "Capacitors" },
  { id: "CG_Inductors", label: "Inductors" },
  { id: "CG_Ferrites_Chokes", label: "Ferrites & Chokes" },
  { id: "CG_Transformers", label: "Transformers" },
  { id: "CG_Filters", label: "Filters" },
  { id: "CG_Crystals", label: "Crystals" },
  { id: "CG_Oscillators", label: "Oscillators" },
  { id: "CG_Diodes", label: "Diodes" },
  { id: "CG_Zener_Diodes", label: "Zener Diodes" },
  { id: "CG_TVS_ESD_Protection", label: "TVS & ESD Protection" },
  { id: "CG_Bipolar_Transistors", label: "Bipolar Transistors" },
  { id: "CG_MOSFETs", label: "MOSFETs" },
  { id: "CG_JFETs", label: "JFETs" },
  { id: "CG_Thyristors", label: "Thyristors" },
  { id: "CG_Microcontrollers", label: "Microcontrollers" },
  { id: "CG_Microprocessors", label: "Microprocessors" },
  { id: "CG_Memory", label: "Memory" },
  { id: "CG_Logic", label: "Logic" },
  { id: "CG_Operational_Amplifiers", label: "Operational Amplifiers" },
  { id: "CG_Comparators", label: "Comparators" },
  { id: "CG_Data_Converters", label: "Data Converters" },
  { id: "CG_Interface_ICs", label: "Interface ICs" },
  { id: "CG_Clock_Timing_ICs", label: "Clock & Timing ICs" },
  { id: "CG_Power_Management_ICs", label: "Power Management ICs" },
  { id: "CG_Driver_ICs", label: "Driver ICs" },
  { id: "CG_Audio_ICs", label: "Audio ICs" },
  { id: "CG_RF_Amplifiers", label: "RF Amplifiers" },
  { id: "CG_RF_Mixers", label: "RF Mixers" },
  { id: "CG_RF_Modulators_Demodulators", label: "RF Modulators & Demodulators" },
  { id: "CG_RF_Switches", label: "RF Switches" },
  { id: "CG_RF_Attenuators", label: "RF Attenuators" },
  { id: "CG_RF_Synthesizers", label: "RF Synthesizers" },
  { id: "CG_RF_Filters_Passives", label: "RF Filters & Passives" },
  { id: "CG_RF_Transceivers", label: "RF Transceivers" },
  { id: "CG_Sensors", label: "Sensors" },
  { id: "CG_Optoelectronics", label: "Optoelectronics" },
  { id: "CG_Connectors", label: "Connectors" },
  { id: "CG_Switches_Relays_Circuit_Protection", label: "Switches, Relays & Circuit Protection" },
] as const;

const categoryLabels = new Map<string, string>(
  libraryCategories.map((category) => [category.id, category.label]),
);

export function displayCategory(category: string) {
  return categoryLabels.get(category)
    ?? category.replace(/^CG_/, "").replaceAll("_", " ");
}

export function sanitizeCatalogTitle(title: string) {
  return title
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function sanitizeManufacturerName(name: string) {
  return sanitizeCatalogTitle(name)
    .replace(/\([^)]*\)/g, "")
    .replace(/[()]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
