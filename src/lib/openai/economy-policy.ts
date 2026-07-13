export const OPENAI_ECONOMY_POLICY = Object.freeze({
  contextualResponse: {
    maxOutputTokens: 220,
    recentMessages: 8,
    messageCharacters: 450,
    knowledgeArticles: 5,
    knowledgeCharacters: 900
  },
  contextualDecision: {
    maxOutputTokens: 200,
    recentMessages: 6,
    messageCharacters: 450
  },
  intent: {
    maxOutputTokens: 100,
    messageCharacters: 600
  },
  salesResponse: {
    defaultOutputTokens: 90,
    commercialOutputTokens: 130,
    technicalOutputTokens: 160,
    recentMessages: 6,
    messageCharacters: 420,
    knowledgeArticles: 5,
    knowledgeCharacters: 900
  },
  specialistAnalysis: {
    maxOutputTokens: 200
  },
  dailyLearning: {
    maxOutputTokens: 360,
    maxExamples: 8,
    maxDirectives: 3
  }
});
