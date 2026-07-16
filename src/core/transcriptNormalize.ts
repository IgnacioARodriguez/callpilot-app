const trailingTechnicalAcronyms = [
  "SQL",
  "API",
  "HTTP",
  "HTTPS",
  "HTML",
  "CSS",
  "JSON",
  "JWT",
  "REST",
  "TCP",
  "UDP",
  "DNS",
  "ORM",
  "OOP",
  "AWS",
  "GCP",
  "CI",
  "CD",
  "SOLID",
];

const repairTrailingDefinitionAcronym = (text: string): string =>
  text.replace(
    /(\b(?:que|qué|what)\s+(?:es|son|is|are)\s+)([a-z]{2,4})(\s*[?.!]?\s*)$/iu,
    (match, prefix: string, token: string, suffix: string) => {
      const upperToken = token.toUpperCase();
      if (trailingTechnicalAcronyms.includes(upperToken)) return match;
      const matches = trailingTechnicalAcronyms.filter((acronym) =>
        acronym.startsWith(upperToken) && acronym.length > upperToken.length,
      );
      return matches.length === 1 ? `${prefix}${matches[0]}${suffix}` : match;
    },
  );

export const normalizeTechnicalTranscript = (text: string): string =>
  repairTrailingDefinitionAcronym(
    text
      .replace(/\bese\s*cu\s*ele\b/gi, "SQL")
      .replace(/\besecoele\b/gi, "SQL")
      .replace(/\bsequel\b/gi, "SQL")
      .replace(/\ba\s*pi\b/gi, "API")
      .replace(/\bapis\b/gi, "APIs"),
  );
