export const OPENAI_ECONOMY_POLICY = Object.freeze({
  contextualResponse: {
    defaultOutputTokens: 100,
    complexOutputTokens: 140,
    currentMessageCharacters: 300,
    profileValueCharacters: 180,
    operationalValueCharacters: 180,
    recentMessages: 4,
    messageCharacters: 240,
    knowledgeArticles: 2,
    knowledgeCharacters: 420
  },
  contextualDecision: {
    maxOutputTokens: 180,
    currentMessageCharacters: 180,
    profileValueCharacters: 90,
    specialistGuidanceCharacters: 70,
    recentMessages: 2,
    messageCharacters: 140,
    knowledgeArticles: 1,
    knowledgeCharacters: 240
  },
  intent: {
    maxOutputTokens: 70,
    messageCharacters: 450
  },
  salesResponse: {
    defaultOutputTokens: 60,
    commercialOutputTokens: 80,
    technicalOutputTokens: 110,
    recentMessages: 4,
    messageCharacters: 240,
    knowledgeArticles: 2,
    knowledgeCharacters: 420
  },
  specialistAnalysis: {
    maxOutputTokens: 120
  },
  dailyLearning: {
    maxOutputTokens: 220,
    maxExamples: 6,
    maxDirectives: 3
  }
});
